import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RulesEditor from '../RulesEditor';
import type { StoredRuleForm } from '../../../../shared/devRulesUtils';

vi.mock('../../../panel/utils/i18n', () => ({
  t: (key: string, value?: string) => value ? key + ': ' + value : key,
  getCurrentLanguage: () => 'en',
}));
vi.mock('../../../panel/utils/browserUiSettings', () => ({ useBrowserUiSettings: () => ({}) }));

vi.mock('../../../panel/components/CodeEditor', () => ({
  CodeEditor: ({ code, onChange }: { code: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="rule-json"
      value={code}
      onChange={event => onChange(event.target.value)}
    />
  ),
}));

describe('RulesEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.runtime.sendMessage = vi.fn(async message => ({
      success: true,
      rulesCount: message.enabled ? message.forms.filter((form: StoredRuleForm) => form.enabled !== false).length : 0,
    })) as any;
    chrome.permissions = {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
      onAdded: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    } as unknown as typeof chrome.permissions;
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
    chrome.storage.local.get = vi.fn((_keys, callback) => {
      callback({ devRulesEnabled: false });
    }) as any;
    chrome.storage.sync = {
      get: vi.fn((_keys, callback) => {
        callback({ dnrIndicatorMode: 'dot' });
      }),
      set: vi.fn(),
    } as any;
    chrome.declarativeNetRequest = {
      getDynamicRules: vi.fn(callback => callback([])),
      updateDynamicRules: vi.fn(),
    } as any;
  });

  afterEach(() => vi.useRealTimers());

  function loadMissingPermissionRule() {
    vi.useFakeTimers();
    const rule: StoredRuleForm = {
      id: 1,
      priority: 1,
      actionType: 'modifyHeaders',
      redirectType: 'url',
      redirectUrl: '',
      regexSubstitution: '',
      filterType: 'regexFilter',
      regexFilter: '^https://example\\.com/',
      urlFilter: '',
      initiatorDomains: '',
      resourceTypes: ['xmlhttprequest'],
      responseHeaders: [{ header: 'x-test', operation: 'set', value: '1' }],
    };
    chrome.storage.local.get = vi.fn((_keys, callback) =>
      callback({ devRulesEnabled: true, devRulesFormConfig: [rule] }),
    ) as any;
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
    chrome.declarativeNetRequest.updateDynamicRules = vi.fn((_options, callback) =>
      callback?.(),
    ) as any;
    render(<RulesEditor />);
  }

  it('renders caller navigation alongside the existing header actions', () => {
    const onBack = vi.fn();
    render(<RulesEditor onBack={onBack} headerActions={<button>switch tool</button>} />);
    fireEvent.click(screen.getByRole('button', { name: 'toolboxBack' }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'switch tool' })).toBeInTheDocument();
  });

  it('automatically opens a domain permission dialog, preserves the draft when denied, and permits retry', async () => {
    loadMissingPermissionRule();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeVisible();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(screen.getByText('https://example.com/*')).toBeInTheDocument();
    vi.mocked(chrome.permissions.request).mockImplementationOnce(async () => false);
    await act(async () => {
      fireEvent.click(dialog.querySelectorAll('button')[1]);
    });
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    expect(screen.getByRole('alert')).toHaveTextContent('rulePermissionFailed');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => true);
    await act(async () => {
      fireEvent.click(dialog.querySelectorAll('button')[1]);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not repeatedly prompt for a dismissed domain when editing the same rule', async () => {
    loadMissingPermissionRule();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.change(screen.getByPlaceholderText('ruleDescriptionPlaceholder'), {
      target: { value: 'Updated' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).toBeVisible();
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
  });

  it('checks rules imported through JSON mode', async () => {
    loadMissingPermissionRule();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'ruleModeJson' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'rule-json' }), {
      target: {
        value: JSON.stringify([
          {
            id: 2,
            priority: 1,
            action: { type: 'redirect', redirect: { url: 'https://target.invalid/' } },
            condition: { regexFilter: '^https://imported\\.invalid/' },
          },
        ]),
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('https://imported.invalid/*')).toBeInTheDocument();
  });

  it('manages the DNR indicator setting when embedded outside Options', async () => {
    render(<RulesEditor />);

    expect(screen.getByRole('heading', { name: 'rulesConfig' })).toBeInTheDocument();
    expect(screen.getByText('rulesDisabledTitle')).toBeInTheDocument();

    await screen.findByRole('button', { name: 'dnrIndicatorModeDot' });

    fireEvent.click(screen.getByRole('button', { name: 'dnrIndicatorModeNumber' }));

    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ dnrIndicatorMode: 'number' });
  });

  it('does not render a false switch state before storage is restored', () => {
    let resolveStorage: ((result: Record<string, unknown>) => void) | undefined;
    chrome.storage.local.get = vi.fn((_keys, callback) => {
      resolveStorage = callback;
    }) as any;

    render(<RulesEditor />);

    expect(screen.queryByRole('switch', { name: 'rulesConfig' })).not.toBeInTheDocument();
    expect(screen.queryByText('rulesDisabledTitle')).not.toBeInTheDocument();
    expect(screen.getByTestId('rules-editor-loading')).toBeInTheDocument();

    act(() => resolveStorage?.({ devRulesEnabled: true }));

    expect(screen.getByRole('switch', { name: 'rulesConfig' })).toBeChecked();
    expect(screen.getByTestId('rules-editor-content')).toBeInTheDocument();
  });

  it('enables rule editing from the popup header', async () => {
    render(<RulesEditor />);

    fireEvent.click(await screen.findByRole('switch', { name: 'rulesConfig' }));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'saveDevRules', forms: [], enabled: true });
    expect(screen.getByTestId('rules-editor-content')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ruleAddRule' }));
    fireEvent.click(screen.getByRole('button', { name: 'ruleAddBlank' }));

    const summary = screen.getByRole('button', { expanded: true });
    expect(screen.getByPlaceholderText('ruleDescriptionPlaceholder')).toBeInTheDocument();

    fireEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByPlaceholderText('ruleDescriptionPlaceholder')).toBeNull();
    expect(screen.queryByText('rulesDisabledTitle')).toBeNull();
  });

  const rule: StoredRuleForm = {
    id: 1, priority: 1, actionType: 'block', redirectType: 'url', redirectUrl: '',
    regexSubstitution: '', filterType: 'urlFilter', urlFilter: '||example.test/',
    regexFilter: '', initiatorDomains: '', resourceTypes: ['xmlhttprequest'], description: 'Original',
  };
  function loadRule() {
    vi.useFakeTimers();
    chrome.storage.local.get = vi.fn((_keys, callback) => callback({
      devRulesEnabled: true, devRulesFormConfig: [rule],
    })) as any;
    return render(<RulesEditor />);
  }
  const saves = () => vi.mocked(chrome.runtime.sendMessage).mock.calls.map(([message]) => message as any);

  it('does not save or reapply on restoration or when only expanding a rule', async () => {
    loadRule();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(saves()).toEqual([]);
    expect(chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
  });

  it('submits a rule toggle immediately and does not enqueue another delayed save', async () => {
    loadRule();
    fireEvent.click(screen.getByRole('switch', { name: 'enabled' }));
    expect(saves()).toEqual([{ action: 'saveDevRules', enabled: true, forms: [{ ...rule, enabled: false }] }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(saves()).toHaveLength(1);
  });

  it('keeps the header text stable while a toggle is being applied', async () => {
    loadRule();
    let finish!: (value: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
    const header = screen.getByTestId('rules-editor-header');
    const previous = header.textContent;
    fireEvent.click(screen.getByRole('switch', { name: 'enabled' }));
    expect(header.textContent).toBe(previous);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { finish({ success: true, rulesCount: 0 }); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('coalesces text input and uses the latest draft for an immediate global toggle', async () => {
    loadRule();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.change(screen.getByPlaceholderText('ruleDescriptionPlaceholder'), { target: { value: 'Latest' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(saves()).toEqual([]);
    fireEvent.click(screen.getByRole('switch', { name: 'rulesConfig' }));
    fireEvent.click(screen.getByRole('switch', { name: 'rulesConfig' }));
    expect(saves()).toEqual([false, true].map(enabled => ({ action: 'saveDevRules', enabled, forms: [{ ...rule, description: 'Latest' }] })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(saves()).toHaveLength(2);
  });

  it('flushes the last text edit on unmount before the debounce elapses', () => {
    const view = loadRule();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.change(screen.getByPlaceholderText('ruleDescriptionPlaceholder'), { target: { value: 'Closing' } });
    expect(saves()).toEqual([]);
    view.unmount();
    expect(saves()).toEqual([{ action: 'saveDevRules', enabled: true, forms: [{ ...rule, description: 'Closing' }] }]);
  });

  it('keeps one pending snapshot when switching from JSON back to the form', async () => {
    loadRule();
    fireEvent.click(screen.getByRole('button', { name: 'ruleModeJson' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'rule-json' }), { target: { value: JSON.stringify([{ ...rule, description: 'JSON latest' }]) } });
    fireEvent.click(screen.getByRole('button', { name: 'ruleModeForm' }));
    expect(saves()).toHaveLength(1);
    expect(saves()[0].forms[0].description).toBe('JSON latest');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(saves()).toHaveLength(1);
  });

  it('does not submit an older JSON snapshot after the draft becomes incomplete', async () => {
    loadRule();
    fireEvent.click(screen.getByRole('button', { name: 'ruleModeJson' }));
    const editor = screen.getByRole('textbox', { name: 'rule-json' });
    fireEvent.change(editor, { target: { value: JSON.stringify([{ ...rule, description: 'Intermediate' }]) } });
    fireEvent.change(editor, { target: { value: '[{' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(saves()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'ruleModeForm' }));
    expect(screen.getByText(/rulesJsonParseError/)).toBeVisible();
  });

  it('preserves the preceding form edit when JSON becomes incomplete before closing', async () => {
    const view = loadRule();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.change(screen.getByPlaceholderText('ruleDescriptionPlaceholder'), { target: { value: 'Last valid form' } });
    expect(saves()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'ruleModeJson' }));
    expect(saves()).toEqual([{ action: 'saveDevRules', enabled: true, forms: [{ ...rule, description: 'Last valid form' }] }]);
    fireEvent.change(screen.getByRole('textbox', { name: 'rule-json' }), { target: { value: '[{' } });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(saves()).toHaveLength(1);
  });

  it('retains the draft and shows an apply failure with the actual applied count', async () => {
    loadRule();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ success: false, rulesCount: 1, error: 'Invalid regular expression' });
    fireEvent.click(screen.getByRole('switch', { name: 'enabled' }));
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid regular expression');
    expect(screen.getByRole('switch', { name: 'disabled' })).not.toBeChecked();
    expect(screen.getByText('Original')).toBeVisible();
  });
});
