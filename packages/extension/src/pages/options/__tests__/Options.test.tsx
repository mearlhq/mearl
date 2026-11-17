import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Options from '../Options';
import { ToastContainer } from '../../panel/components/ToastContainer';
import { PRESET_MANAGEMENT_ACTION } from '../../../shared/presetAutoUpdate';
import { INSTALLATION_ACTION } from '../../../shared/installation';
import {
  DEFAULT_TAB_PAGE_OVERRIDES,
  TAB_PAGE_OVERRIDES_GET_ACTION,
  TAB_PAGE_OVERRIDES_SET_ACTION,
} from '../../../shared/tabPageOverrides';

const installed = vi.hoisted(() => ({
  operations: {} as Record<string, { hook: string; setting: string }>,
  views: {} as Record<string, unknown>,
}));
vi.mock('../../panel/utils/browserUiSettings', () => ({
  useBrowserUiSettings: () => ({ operations: installed.operations }),
}));
vi.mock('../../panel/components/browser-view/viewState', () => ({
  useBrowserView: (slot: string) => ({ loaded: true, selected: installed.views[slot] }),
}));
vi.mock('../../panel/utils/i18n', () => ({
  initI18n: vi.fn(async () => {}),
  getCurrentLanguage: () => 'en',
  t: (key: string, substitutions?: string) => (substitutions ? `${key}: ${substitutions}` : key),
}));
vi.mock('../../../shared/hooks/useFontSize', () => ({
  useFontSize: () => ({ currentLevel: 1, setLevel: vi.fn() }),
}));
vi.mock('../components/TranslationDictEditor', () => ({ default: () => null }));
vi.mock('../components/AgentPermissionsSection', () => ({ default: () => null }));

describe('Options settings', () => {
  beforeEach(() => {
    installed.operations = {};
    installed.views = {};
    window.history.replaceState({}, '', '/');
    chrome.storage.session = { get: vi.fn().mockResolvedValue({}) } as any;
    chrome.storage.sync = {
      get: vi.fn((defaults, callback) => callback(defaults)),
      set: vi.fn((_config, callback) => callback?.()),
    } as any;
    vi.mocked(chrome.runtime.sendMessage).mockReset();
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      const request = message as unknown as { action?: string; patch?: Record<string, unknown> };
      if (request.action === TAB_PAGE_OVERRIDES_GET_ACTION) {
        return { success: true, overrides: DEFAULT_TAB_PAGE_OVERRIDES };
      }
      if (request.action === TAB_PAGE_OVERRIDES_SET_ACTION) {
        return { success: true, overrides: { ...DEFAULT_TAB_PAGE_OVERRIDES, ...request.patch } };
      }
      if (request.action === 'setGlobalTranslation' || request.action === 'enableModification') {
        return { success: true };
      }
      return undefined;
    });
  });

  it.each(['?iframe=1', '?iframe=1&tabId=7'])(
    'hides duplicate quick settings in the embedded page %s',
    async context => {
      window.history.replaceState({}, '', context);
      render(<Options />);
      await screen.findByRole('switch', { name: 'mcpService' });
      for (const key of ['language', 'fontSize', 'envSwitch', 'agentFloatingButton']) {
        expect(screen.queryByText(key)).toBeNull();
      }
      expect(Boolean(screen.queryByText('settingsGroupGeneral'))).toBe(context.includes('tabId='));
    },
  );

  it('shows general and quick settings when opened as a standalone page', async () => {
    render(<Options />);
    await screen.findByRole('switch', { name: 'agentFloatingButton' });
    for (const key of ['settingsGroupGeneral', 'language', 'fontSize']) {
      expect(screen.getByText(key)).toBeVisible();
    }
    expect(screen.queryByText('envSwitch')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'customUserAgent' })).toBeNull();
    expect(screen.queryByText('customDateTime')).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: TAB_PAGE_OVERRIDES_GET_ACTION }),
    );
  });

  it.each([
    { context: '?iframe=1&tabId=7', available: true },
    { context: '', available: true },
    { context: '?iframe=1&tabId=7', available: false },
  ])(
    'opens the preset installation dialog in settings ($context, $available)',
    async ({ context, available }) => {
      window.history.replaceState({}, '', '/' + context);
      const previous = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message, ...args) => {
        const request = message as { action?: string; operation?: string };
        if (request.action === INSTALLATION_ACTION) {
          return {
            success: true,
            data: {
              session: 'preset-selector',
              presetId: 'team',
              label: 'Team',
              source: 'https://example.test/team.json',
              origins: [],
              missingOrigins: [],
              missingAuthorization: [],
              needsInstall: true,
              presetChoices: [{ id: 'team', label: 'Team' }],
            },
          };
        }
        if (request.action !== PRESET_MANAGEMENT_ACTION) return previous(message, ...args);
        if (request.operation === 'status') return { success: true, data: [] };
        if (request.operation === 'install-available') return { success: true, data: true };
        return available
          ? { success: true, data: { session: 'preset-selector', inline: true } }
          : { success: false, error: 'INSTALLATION_PRESET_UNAVAILABLE' };
      });
      render(
        <>
          <Options />
          <ToastContainer />
        </>,
      );
      const install = await screen.findByRole('button', { name: 'presetManagementInstall' });
      fireEvent.click(install);
      await waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          action: PRESET_MANAGEMENT_ACTION,
          operation: 'install',
          inline: true,
        }),
      );
      if (available) {
        expect(await screen.findByRole('dialog')).toContainElement(
          await screen.findByRole('button', { name: 'presetInstallConfirmOnce' }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'presetInstallCancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() => expect(install).toHaveFocus());
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          action: INSTALLATION_ACTION,
          operation: 'cancel',
          session: 'preset-selector',
        });
      } else {
        expect(await screen.findByText('presetManagementNoPresets')).toBeVisible();
      }
    },
  );
  it('opens the installer for the current preset and waits for confirmation', async () => {
    window.history.replaceState({}, '', '?iframe=1&tabId=7');
    const preset = {
      id: 'team',
      version: '1.0.0',
      source: 'https://example.test/team.json',
      browserRevision: 'a'.repeat(64),
      nativeRevision: 'b'.repeat(64),
    };
    const previous = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message, ...args) => {
      const request = message as unknown as { action?: string; operation?: string } | undefined;
      if (request?.action === INSTALLATION_ACTION) {
        if (request.operation === 'preview') return { success: true, data: {} };
        return {
          success: true,
          data: {
            session: 'preset-selector',
            presetId: preset.id,
            label: 'Team',
            source: preset.source,
            missingOrigins: [],
            missingAuthorization: [],
            needsInstall: request.operation !== 'install',
            browserReady: request.operation === 'install',
            presetChoices: [{ id: preset.id, label: 'Team' }],
          },
        };
      }
      if (request?.action !== PRESET_MANAGEMENT_ACTION) return previous(message, ...args);
      if (request.operation === 'status') return { success: true, data: [preset] };
      return { success: true, data: { session: 'preset-selector', inline: true } };
    });

    render(<Options />);
    expect(await screen.findByText('v1.0.0')).toBeVisible();
    const update = screen.getByRole('button', { name: 'presetManagementUpdate' });
    expect(
      within(screen.getByRole('region', { name: 'presetManagementTitle' })).getAllByRole('button'),
    ).toEqual([update]);
    fireEvent.click(update);
    const confirm = await screen.findByRole('button', { name: 'presetInstallConfirmOnce' });
    expect(screen.getByRole('dialog')).toContainElement(confirm);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: PRESET_MANAGEMENT_ACTION,
      operation: 'install',
      inline: true,
      presetId: preset.id,
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: INSTALLATION_ACTION, operation: 'install' }),
    );
    fireEvent.click(confirm);
    await screen.findByText('presetInstallBrowserReady');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: INSTALLATION_ACTION,
        operation: 'install',
        presetId: preset.id,
        authorize: true,
      }),
    );
  });

  it('uses the supplied preview tab for embedded settings', async () => {
    window.history.replaceState({}, '', '?iframe=1&tabId=7');
    const title = document.title;
    render(<Options embeddedTabId={41} />);
    expect(await screen.findByRole('switch', { name: 'customUserAgent' })).toBeVisible();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: TAB_PAGE_OVERRIDES_GET_ACTION,
      tabId: 41,
    });
    expect(screen.queryByText('language')).not.toBeInTheDocument();
    expect(document.title).toBe(title);
  });

  it('updates the floating entry preference from the standalone page', async () => {
    render(<Options />);
    const toggle = await screen.findByRole('switch', { name: 'agentFloatingButton' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(chrome.storage.sync.set).toHaveBeenCalledWith(
        { agentFloatingButtonEnabled: true },
        expect.any(Function),
      ),
    );
    expect(toggle).toBeChecked();
  });

  it('disables the standalone floating entry control while Agent service is off', async () => {
    vi.mocked(chrome.storage.sync.get).mockImplementation((defaults, callback) =>
      callback({ ...(defaults as object), agentEnabled: false }),
    );
    render(<Options />);
    expect(await screen.findByRole('switch', { name: 'agentFloatingButton' })).toBeDisabled();
  });

  it.each([false, true])('loads and toggles the foreground preference from %s', async enabled => {
    vi.mocked(chrome.storage.sync.get).mockImplementation((defaults, callback) =>
      callback({ ...(defaults as object), agentPreventForeground: enabled }),
    );
    render(<Options />);
    const toggle = await screen.findByRole('button', { name: 'agentPreventForeground' });
    expect(toggle).toHaveAttribute('aria-pressed', String(enabled));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(chrome.storage.sync.set).toHaveBeenCalledWith(
        { agentPreventForeground: !enabled },
        expect.any(Function),
      ),
    );
    expect(toggle).toHaveAttribute('aria-pressed', String(!enabled));
    expect(screen.getByRole('switch', { name: 'mcpService' })).toBeChecked();
  });

  it('shows automatic defaults and sends only the selected service preference', async () => {
    installed.operations = { accounts: { hook: 'accounts', setting: 'accountsEnabled' } };
    const values: Record<string, boolean> = {};
    chrome.storage.session = {
      get: vi.fn().mockResolvedValue({
        'external-service-defaults': {
          services: {
            accountsEnabled: true,
            requestCasesEnabled: true,
            requestMetadataEnabled: true,
            requestImportEnabled: true,
            trackingMetadataEnabled: true,
          },
        },
      }),
    } as any;
    vi.mocked(chrome.storage.sync.get).mockImplementation((defaults, callback) =>
      callback({ ...(defaults as object), ...values }),
    );
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      const request = message as unknown as { action: string; patch: Record<string, boolean> };
      if (request.action === 'updateExternalServicePreferences')
        Object.assign(values, request.patch);
      return { success: true };
    });
    render(<Options />);
    const toggle = await screen.findByRole('button', { name: 'accountsServices' });
    expect(toggle).toHaveClass('bg-blue-600');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'updateExternalServicePreferences',
        patch: { accountsEnabled: false },
      }),
    );
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveClass('line-through');
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('keeps request rules out of the settings page', async () => {
    render(<Options />);

    await screen.findByRole('switch', { name: 'mcpService' });
    expect(screen.queryByText('rulesConfig')).toBeNull();
    expect(screen.queryByText('settingsGroupAdvanced')).toBeNull();
  });

  it.each(['en', 'zh-TW'])(
    'enables modification for the settings tab when %s translation is turned off',
    async target => {
      window.history.replaceState({}, '', '?iframe=1&tabId=7');
      vi.mocked(chrome.storage.sync.get).mockImplementation((defaults, callback) =>
        callback({ ...(defaults as object), globalTranslation: target }),
      );
      render(<Options />);
      const off = await screen.findByRole('button', { name: 'globalTranslationNone' });
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'enableModification' }),
      );
      fireEvent.click(off);
      await waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          action: 'enableModification',
          tabId: 7,
        }),
      );
      expect(chrome.storage.sync.set).toHaveBeenCalledWith(
        { globalTranslation: 'none' },
        expect.any(Function),
      );
      const actions = vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.map(([message]) => (message as { action?: string }).action);
      expect(actions.indexOf('setGlobalTranslation')).toBeLessThan(
        actions.indexOf('enableModification'),
      );
      await waitFor(() => expect(off).not.toBeDisabled());
    },
  );

  it.each([
    { from: 'none', to: 'globalTranslationNone', context: '?iframe=1&tabId=7' },
    { from: 'none', to: 'english', context: '?iframe=1&tabId=7' },
    { from: 'en', to: 'traditionalChinese', context: '?iframe=1&tabId=7' },
    { from: 'en', to: 'globalTranslationNone', context: '' },
  ])(
    'does not enable modification for $from → $to with context $context',
    async ({ from, to, context }) => {
      window.history.replaceState({}, '', `/${context}`);
      vi.mocked(chrome.storage.sync.get).mockImplementation((defaults, callback) =>
        callback({ ...(defaults as object), globalTranslation: from }),
      );
      render(<Options />);
      const button = await screen.findByRole('button', { name: to });
      fireEvent.click(button);
      await waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'setGlobalTranslation' }),
        ),
      );
      await waitFor(() => expect(button).not.toBeDisabled());
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'enableModification' }),
      );
    },
  );

  it('does not enable modification when saving the translation preference fails', async () => {
    window.history.replaceState({}, '', '?iframe=1&tabId=7');
    vi.mocked(chrome.storage.sync.get).mockImplementation((defaults, callback) =>
      callback({ ...(defaults as object), globalTranslation: 'en' }),
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation((_values, callback) => {
      chrome.runtime.lastError = { message: 'Storage unavailable' };
      callback?.();
      chrome.runtime.lastError = undefined;
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<Options />);
      const off = await screen.findByRole('button', { name: 'globalTranslationNone' });
      fireEvent.click(off);
      await waitFor(() => expect(error).toHaveBeenCalled());
      await waitFor(() => expect(off).not.toBeDisabled());
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'setGlobalTranslation' }),
      );
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'enableModification' }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it('fills and applies the current time from the compact date-time setting', async () => {
    window.history.replaceState({}, '', '?iframe=1&tabId=7');
    vi.spyOn(Date, 'now').mockReturnValue(1_787_272_260_000);
    try {
      render(<Options />);

      fireEvent.click(await screen.findByRole('button', { name: 'customTimeNow' }));

      await waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          action: TAB_PAGE_OVERRIDES_SET_ACTION,
          tabId: 7,
          patch: { customTime: 1_787_272_260_000 },
        }),
      );
      expect((screen.getByLabelText('customTime') as HTMLInputElement).value).toMatch(/^2026-/);

      fireEvent.click(screen.getByRole('button', { name: 'customTimeClear' }));
      await waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
          action: TAB_PAGE_OVERRIDES_SET_ACTION,
          tabId: 7,
          patch: { customTime: null },
        }),
      );
      expect((screen.getByLabelText('customTime') as HTMLInputElement).value).toBe('');
    } finally {
      window.history.replaceState({}, '', '/');
      vi.restoreAllMocks();
    }
  });

  it('keeps the confirmed timezone selected until the site access retry succeeds', async () => {
    window.history.replaceState({}, '', '?iframe=1&tabId=7');
    const origin = 'https://example.test/*';
    const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    const originalSend = sendMessage.getMockImplementation() as (message: unknown) => unknown;
    sendMessage.mockImplementation(async message => {
      if (message.action === TAB_PAGE_OVERRIDES_SET_ACTION && !message.siteAccessOrigin) {
        return { success: false, siteAccessOrigin: origin };
      }
      return originalSend(message);
    });

    render(<Options />);
    fireEvent.click(await screen.findByRole('button', { name: 'timezoneTokyo' }));
    const grant = await screen.findByRole('button', { name: 'timezoneGrantSiteAccess' });
    expect(screen.getByRole('button', { name: 'timezoneSystem' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(grant);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'timezoneTokyo' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
      action: TAB_PAGE_OVERRIDES_SET_ACTION,
      tabId: 7,
      patch: { customTimezone: 'Asia/Tokyo' },
      siteAccessOrigin: origin,
    });
  });

  it('shows clean page defaults for a new tab without saving on open', async () => {
    window.history.replaceState({}, '', '?iframe=1&tabId=8');
    vi.mocked(chrome.storage.sync.get).mockImplementationOnce((defaults, callback) =>
      callback({
        ...(defaults as object),
        customUserAgent: 'Legacy global UA',
        customUserAgentEnabled: true,
        customTimezone: 'Asia/Tokyo',
        customTime: 1_787_272_260_000,
      }),
    );

    render(<Options />);

    expect(await screen.findByRole('switch', { name: 'customUserAgent' })).not.toBeChecked();
    expect((screen.getByLabelText('customTime') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'timezoneSystem' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: TAB_PAGE_OVERRIDES_GET_ACTION,
      tabId: 8,
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: TAB_PAGE_OVERRIDES_SET_ACTION }),
    );
  });
  it('hides the external services section without installed modules', async () => {
    installed.operations = {};
    installed.views = {};
    render(<Options />);
    await screen.findByRole('switch', { name: 'mcpService' });
    expect(screen.queryByText('externalServices')).toBeNull();
  });
  it('shows only installed service settings even when disabled', async () => {
    installed.operations = { accounts: { hook: 'accounts', setting: 'accountsEnabled' } };
    installed.views = {};
    render(<Options />);
    await screen.findByRole('button', { name: 'accountsServices' });
    expect(screen.getByText('externalServices')).toBeVisible();
    for (const name of [
      'requestCasesServices',
      'requestImportServices',
      'trackingMetadataServices',
    ])
      expect(screen.queryByText(name)).toBeNull();
  });
});
