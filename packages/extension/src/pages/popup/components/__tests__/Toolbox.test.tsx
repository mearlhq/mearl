import { ExtensionRpcError } from '@mearl/browser-core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { Toolbox } from '../Toolbox';
import catalogFixture from '../../../../test/fixtures/toolboxCatalog';
import { parseToolboxCatalog } from '../../../../shared/toolboxCatalog';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  openPlugin: vi.fn(),
  toast: vi.fn(),
  native: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock('../../hooks/useToolboxCatalog', () => ({ useToolboxCatalog: mocks.catalog }));

vi.mock('../../../panel/utils/i18n', () => ({
  getCurrentLanguage: () => 'en',
  t: (key: string) => key,
}));
vi.mock('../../toolboxRequest', async importOriginal => ({
  ...(await importOriginal<typeof import('../../toolboxRequest')>()),
  requestToolbox: mocks.list,
}));
vi.mock('../../../sidepanel/nativeHostRequest', () => ({ requestNativeHost: mocks.native }));
vi.mock('../../../panel/utils/toast', () => ({ showToast: mocks.toast }));
vi.mock('../../../../shared/toolboxTab', () => ({
  openToolboxToolTab: mocks.openPlugin,
}));
vi.mock('../../../tool-host/SandboxToolPage', () => ({
  SandboxToolPage: ({
    embedded,
    headerActions,
    onBack,
    onOpenInTab,
    onQueryChange,
    query,
    title,
  }: {
    embedded?: boolean;
    headerActions?: ReactNode;
    onBack?: () => void;
    onOpenInTab?: () => void;
    onQueryChange?: (query: Record<string, string>) => void;
    query?: Record<string, string>;
    title: string;
  }) => (
    <div
      data-testid="sandbox-tool"
      data-embedded={String(embedded)}
      data-has-back={String(Boolean(onBack))}
      data-query={JSON.stringify(query)}
    >
      {title}
      {headerActions}
      <button type="button" onClick={onBack}>
        sandbox-back
      </button>
      {onOpenInTab && (
        <button type="button" onClick={onOpenInTab}>
          sandbox-open-tab
        </button>
      )}
      <button type="button" onClick={() => onQueryChange?.({ id: 'notebook-id' })}>
        sandbox-select
      </button>
    </div>
  ),
}));
vi.mock('../DeviceCaptureEntry', () => ({
  DeviceCaptureEntry: ({
    onBack,
    headerActions,
  }: {
    onBack?: () => void;
    headerActions?: ReactNode;
  }) => (
    <div data-testid="device-capture">
      {headerActions}
      <button type="button" onClick={onBack}>
        capture-back
      </button>
    </div>
  ),
}));

describe('Toolbox', () => {
  it('disables and restores Skill discovery while keeping the tool available', async () => {
    let enabled = true;
    mocks.list.mockImplementation(async (action: string, data?: { enabled?: boolean }) => {
      if (action === 'toolbox_skill_set_enabled') {
        enabled = data!.enabled!;
        return { enabled };
      }
      return {
        tools: [
          {
            id: 'plugin:notebook',
            plugin: 'notebook',
            title: 'Workspace Notes',
            order: 100,
            skillEnabled: enabled,
          },
        ],
      };
    });
    render(<Toolbox />);
    const tool = await screen.findByRole('button', { name: /Workspace Notes/ });
    expect(screen.queryByRole('button', { name: 'toolboxSkillDisable' })).toBeNull();
    fireEvent.contextMenu(tool, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSkillDisable' }));
    await screen.findByRole('img', { name: 'toolboxSkillDisabled' });
    expect(mocks.list).toHaveBeenCalledWith('toolbox_skill_set_enabled', {
      id: 'plugin:notebook',
      enabled: false,
    });
    expect(screen.getByRole('button', { name: /Workspace Notes/ })).not.toBeDisabled();
    expect(mocks.toast).toHaveBeenCalledWith('toolboxSkillDisabledSuccess', 'success');
    fireEvent.contextMenu(tool, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSkillEnable' }));
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: 'toolboxSkillDisabled' })).toBeNull(),
    );
    expect(mocks.list).toHaveBeenCalledWith('toolbox_skill_set_enabled', {
      id: 'plugin:notebook',
      enabled: true,
    });
    expect(mocks.toast).toHaveBeenCalledWith('toolboxSkillEnabledSuccess', 'success');
  });

  it('retains Skill state after a failed toggle and allows retry', async () => {
    let rejectToggle!: (reason: Error) => void;
    const pending = new Promise((_resolve, reject) => {
      rejectToggle = reject;
    });
    mocks.list.mockImplementation(async (action: string) => {
      if (action === 'toolbox_skill_set_enabled') return pending;
      return {
        tools: [
          {
            id: 'plugin:notebook',
            plugin: 'notebook',
            title: 'Workspace Notes',
            order: 100,
            skillEnabled: true,
          },
        ],
      };
    });
    render(<Toolbox />);
    const tool = await screen.findByRole('button', { name: /Workspace Notes/ });
    fireEvent.contextMenu(tool, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSkillDisable' }));
    fireEvent.contextMenu(tool, { clientX: 100, clientY: 100 });
    expect(screen.getByRole('button', { name: 'toolboxSkillDisable' })).toBeDisabled();
    rejectToggle(new Error('read-only directory'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'toolboxSkillDisable' })).not.toBeDisabled(),
    );
    expect(screen.queryByRole('img', { name: 'toolboxSkillDisabled' })).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith('toolboxSkillToggleFailed', 'error');
  });

  it('dismisses the Skill context menu without opening the tool or changing its state', async () => {
    mocks.list.mockResolvedValue({
      tools: [
        {
          id: 'plugin:notebook',
          plugin: 'notebook',
          title: 'Workspace Notes',
          order: 100,
          skillEnabled: true,
        },
      ],
    });
    render(<Toolbox />);
    const tool = await screen.findByRole('button', { name: /Workspace Notes/ });
    fireEvent.contextMenu(tool, { clientX: 675, clientY: 555 });
    expect(screen.getByRole('button', { name: 'toolboxSkillDisable' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'toolboxSkillDisable' })).toBeNull();
    fireEvent.contextMenu(tool, { clientX: 100, clientY: 100 });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('button', { name: 'toolboxSkillDisable' })).toBeNull();
    expect(mocks.list.mock.calls.every(([action]) => action === 'toolbox_tools_list')).toBe(true);
  });

  it('hides the capture row and ignores a saved capture selection when disabled', async () => {
    window.localStorage.setItem(
      'mearl.popup.toolbox.activeTool',
      JSON.stringify({ kind: 'capture' }),
    );
    render(<Toolbox requestCasesEnabled={false} />);
    await screen.findByRole('button', { name: /Workspace Notes/ });
    expect(screen.queryByTestId('device-capture')).toBeNull();
    expect(screen.queryByText('toolboxDeviceCaptureTitle')).toBeNull();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.catalog.mockReturnValue({
      tools: parseToolboxCatalog(catalogFixture),
      loading: false,
      failed: false,
      retry: vi.fn(),
    });
    vi.mocked(chrome.runtime.sendMessage)
      .mockReset()
      .mockResolvedValue({
        success: true,
        status: { connected: true, extensionVersion: '2.20.0', nativeHostVersion: '2.20.0' },
      });
    mocks.native
      .mockReset()
      .mockImplementation(async (action: string) =>
        action === 'agent_skills_check_updates'
          ? { updates: [{ name: 'notebook-skill', scope: 'global' }] }
          : { ok: true },
      );
    mocks.openPlugin.mockResolvedValue(undefined);
    window.history.replaceState({}, '', '/');
    window.localStorage.clear();
    mocks.list.mockImplementation(async (action: string) => {
      if (action === 'toolbox_tool_open') {
        return {
          title: 'Workspace Notes',
          agent: { enabled: true, layout: 'workspace' },
          page: { type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 },
        };
      }
      return {
        tools: [
          {
            id: 'plugin:notebook',
            plugin: 'notebook',
            title: 'Workspace Notes',
            description: 'Track repositories',
            skillUpdate: { name: 'notebook-skill', scope: 'global' },
            icon: 'git-branch',
            order: 100,
          },
        ],
      };
    });
    vi.spyOn(window, 'close').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the active tool when opening, switching and returning to the list', async () => {
    const onSelectionChange = vi.fn();
    render(<Toolbox requestCasesEnabled onSelectionChange={onSelectionChange} />);
    await screen.findByRole('button', { name: /Workspace Notes/ });
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: /Workspace Notes/ }));
    await screen.findByTestId('sandbox-tool');
    expect(onSelectionChange).toHaveBeenLastCalledWith('plugin:notebook');
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'toolboxDeviceCaptureTitle' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith('builtin:capture');
    fireEvent.click(screen.getByRole('button', { name: 'capture-back' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });

  it('persists the active tool icon with its query for the next popup render', async () => {
    render(<Toolbox requestCasesEnabled />);
    fireEvent.click(await screen.findByRole('button', { name: /Workspace Notes/ }));
    await screen.findByTestId('sandbox-tool');
    fireEvent.click(screen.getByRole('button', { name: 'sandbox-select' }));
    expect(
      JSON.parse(window.localStorage.getItem('mearl.popup.toolbox.activeTool')!),
    ).toMatchObject({
      id: 'plugin:notebook',
      icon: 'git-branch',
      query: { id: 'notebook-id' },
    });
  });

  it('preserves the saved icon while restoring a tool before metadata is available', () => {
    window.localStorage.setItem(
      'mearl.popup.toolbox.activeTool',
      JSON.stringify({
        kind: 'plugin',
        id: 'plugin:notebook',
        title: 'Workspace Notes',
        icon: 'git-branch',
      }),
    );
    mocks.list.mockReturnValue(new Promise(() => {}));
    render(<Toolbox requestCasesEnabled />);
    expect(
      JSON.parse(window.localStorage.getItem('mearl.popup.toolbox.activeTool')!),
    ).toMatchObject({
      icon: 'git-branch',
    });
  });

  it('keeps the install entry compact while the initial plugin list is pending', async () => {
    const tool = {
      id: 'plugin:notebook',
      plugin: 'notebook',
      title: 'Workspace Notes',
      order: 100,
    };
    let finish!: (result: { tools: Array<typeof tool> }) => void;
    mocks.list.mockReturnValueOnce(
      new Promise<{ tools: Array<typeof tool> }>(resolve => {
        finish = resolve;
      }),
    );
    render(<Toolbox />);
    const button = screen.getByRole('button', { name: 'toolboxInstallTools' });
    expect(button.textContent).toBe('');
    await act(async () => finish({ tools: [tool] }));
    expect(button.textContent).toBe('');
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'toolboxInstallTools' })).toBeInTheDocument();
  });

  it('keeps the empty-toolbox entry text visible during subsequent refreshes', async () => {
    mocks.list.mockResolvedValue({ tools: [] });
    render(<Toolbox />);
    const button = screen.getByRole('button', { name: 'toolboxInstallTools' });
    await waitFor(() => expect(button).toHaveTextContent('toolboxInstallTools'));
    let finish!: (result: { tools: [] }) => void;
    mocks.list.mockReturnValueOnce(
      new Promise<{ tools: [] }>(resolve => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'toolboxRefresh' }));
    expect(button).toHaveTextContent('toolboxInstallTools');
    await act(async () => finish({ tools: [] }));
    expect(button).toHaveTextContent('toolboxInstallTools');
  });

  it('shows catalog refresh in a reserved header slot without inserting list content', async () => {
    const catalog = {
      tools: parseToolboxCatalog(catalogFixture),
      loading: true,
      failed: false,
      retry: vi.fn(),
    };
    mocks.catalog.mockReturnValue(catalog);
    mocks.list.mockResolvedValue({ tools: [] });
    const view = render(<Toolbox />);
    fireEvent.click(await screen.findByRole('button', { name: 'toolboxInstallTools' }));
    const dialog = screen.getByRole('dialog', { name: 'toolboxInstallTools' });
    const status = within(dialog).getByRole('status', { name: 'toolboxCatalogRefreshing' });
    expect(status.closest('h2')).not.toBeNull();
    expect(within(dialog).queryByText('toolboxCatalogRefreshing')).toBeNull();
    const slot = status.parentElement;
    const list = dialog.querySelector('section');
    mocks.catalog.mockReturnValue({ ...catalog, loading: false });
    view.rerender(<Toolbox />);
    expect(slot).toBeInTheDocument();
    expect(slot).toBeEmptyDOMElement();
    expect(dialog.querySelector('section')).toBe(list);
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  it('offers the website catalog in an empty toolbox and installs a selected tool', async () => {
    let installed = false;
    mocks.native.mockImplementation(async (action: string, input?: unknown) => {
      expect(action).toBe('agent_skills_install');
      expect(input).toEqual({
        providerId: 'codex',
        source: 'https://github.com/mearlhq/mearl',
        name: 'tinypng-compress',
        scope: 'global',
      });
      installed = true;
      return { ok: true, output: 'installed' };
    });
    mocks.list.mockImplementation(async () => ({
      tools: installed
        ? [{ id: 'plugin:tinypng', plugin: 'tinypng', title: 'Image compression', order: 95 }]
        : [],
    }));
    const onToolsChange = vi.fn();
    render(<Toolbox onToolsChange={onToolsChange} />);
    await screen.findByText('toolboxNoInstalledTools');
    const installButton = screen.getByRole('button', { name: 'toolboxInstallTools' });
    expect(installButton).toHaveTextContent('toolboxInstallTools');
    fireEvent.click(installButton);
    const dialog = screen.getByRole('dialog', { name: 'toolboxInstallTools' });
    expect(
      within(dialog).getByRole('region', { name: 'Mearl · mearlhq/mearl' }),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByText('toolboxOfficial')).toHaveLength(
      catalogFixture.tools.length,
    );
    expect(within(dialog).queryByText('mearlhq/mearl')).toBeNull();
    expect(within(dialog).getByText('Format converter')).toBeInTheDocument();
    const row = within(dialog).getByText('Image compression').closest('li')!;
    fireEvent.click(within(row).getByRole('button'));
    await waitFor(() => expect(within(row).getByRole('button')).toBeDisabled());
    await within(row).findByText('toolboxInstalled');
    expect(onToolsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'plugin:tinypng' }),
    ]);
    expect(installButton.textContent).toBe('');
    expect(installButton).toHaveAttribute('title', 'toolboxInstallTools');
    expect(mocks.toast).toHaveBeenCalledWith('toolboxInstallSuccess', 'success');
  });

  it('shows only the Native Host guide when the catalog also fails, then exposes retry after reconnect', async () => {
    mocks.catalog.mockReturnValue({ tools: null, loading: false, failed: true, retry: vi.fn() });
    mocks.list.mockRejectedValue(new Error('Native Host not connected'));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: unknown) =>
      (message as { action?: string })?.action === 'getAgentStatus'
        ? { success: true, status: { connected: false, extensionVersion: '2.20.0' } }
        : { success: true },
    );
    render(<Toolbox requestCasesEnabled />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'toolboxRefresh' })).not.toBeDisabled(),
    );
    expect(screen.queryByText('toolboxNativeHostInstallDescription')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'toolboxInstallTools' }));
    const dialog = screen.getByRole('dialog', { name: 'toolboxInstallTools' });
    expect(within(dialog).getByText('toolboxNativeHostInstallDescription')).toBeVisible();
    expect(within(dialog).queryByText('toolboxCatalogLoadFailed')).toBeNull();
    mocks.list.mockResolvedValue({ tools: [] });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'agentChatNativeHostInstallReconnect' }),
    );
    await within(dialog).findByText('toolboxCatalogLoadFailed');
    expect(within(dialog).queryByText('toolboxNativeHostInstallDescription')).toBeNull();
  });

  it.each([false, true])(
    'keeps the empty list quiet and shows the host guide only in the installer (outdated: %s)',
    async outdated => {
      mocks.list.mockRejectedValue(
        outdated
          ? new ExtensionRpcError('PROTOCOL_MISMATCH', 'Update required')
          : new Error('Native Host not connected'),
      );
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: unknown) =>
        (message as { action?: string })?.action === 'getAgentStatus'
          ? { success: true, status: { connected: outdated, extensionVersion: '3.0.0' } }
          : { success: true },
      );
      render(<Toolbox />);
      await screen.findByText('toolboxNoInstalledTools');
      expect(screen.queryByText('toolboxNativeHostInstallDescription')).toBeNull();
      expect(screen.queryByText('toolboxNativeHostUpdateDescription')).toBeNull();
      expect(screen.queryByText('npx @mearl/setup')).toBeNull();
      expect(screen.queryByText(/toolboxUnavailable/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'toolboxInstallTools' }));
      const dialog = screen.getByRole('dialog', { name: 'toolboxInstallTools' });
      expect(
        within(dialog).getByText(
          outdated ? 'toolboxNativeHostUpdateDescription' : 'toolboxNativeHostInstallDescription',
        ),
      ).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close (ESC)' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByText('toolboxNoInstalledTools')).toBeInTheDocument();
      expect(screen.queryByText('toolboxNativeHostInstallDescription')).toBeNull();
      expect(screen.queryByText('toolboxNativeHostUpdateDescription')).toBeNull();
    },
  );

  it('keeps the catalog visible and guides installation when the Native Host is missing', async () => {
    mocks.list.mockRejectedValue(new Error('Native Host not connected'));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: unknown) =>
      (message as { action?: string })?.action === 'getAgentStatus'
        ? { success: true, status: { connected: false, extensionVersion: '2.20.0' } }
        : { success: true },
    );
    render(<Toolbox requestCasesEnabled />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'toolboxRefresh' })).not.toBeDisabled(),
    );
    expect(screen.queryByText('toolboxNativeHostInstallDescription')).toBeNull();
    expect(screen.getByRole('button', { name: /toolboxDeviceCaptureTitle/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'toolboxInstallTools' }));
    const dialog = screen.getByRole('dialog', { name: 'toolboxInstallTools' });
    expect(within(dialog).getByText('Image compression')).toBeInTheDocument();
    expect(within(dialog).getByText('npx @mearl/setup')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: 'toolboxInstallTool' })).toHaveLength(
      catalogFixture.tools.length,
    );
    expect(
      within(dialog)
        .getAllByRole('button', { name: 'toolboxInstallTool' })
        .every(button => button.hasAttribute('disabled')),
    ).toBe(true);
    mocks.list.mockResolvedValue({ tools: [] });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'agentChatNativeHostInstallReconnect' }),
    );
    await waitFor(() =>
      expect(within(dialog).queryByText('toolboxNativeHostInstallDescription')).toBeNull(),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'resetAgentBridge' });
    expect(
      within(dialog)
        .getAllByRole('button', { name: 'toolboxInstallTool' })
        .every(button => !button.hasAttribute('disabled')),
    ).toBe(true);
  });

  it('offers a host update for an unavailable Skill install interface and permits retry after failures', async () => {
    mocks.list.mockResolvedValue({ tools: [] });
    mocks.native.mockRejectedValue(new Error('Network failure'));
    render(<Toolbox />);
    await screen.findByText('toolboxNoInstalledTools');
    fireEvent.click(screen.getByRole('button', { name: 'toolboxInstallTools' }));
    const dialog = screen.getByRole('dialog', { name: 'toolboxInstallTools' });
    const row = within(dialog).getByText('Image compression').closest('li')!;
    fireEvent.click(within(row).getByRole('button'));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('toolboxInstallFailed', 'error'));
    await waitFor(() => expect(within(row).getByRole('button')).not.toBeDisabled());
    mocks.native.mockRejectedValue(new ExtensionRpcError('PROTOCOL_MISMATCH', 'Update required'));
    fireEvent.click(within(row).getByRole('button'));
    await within(dialog).findByText('toolboxNativeHostUpdateDescription');
    expect(within(dialog).getByText('npx @mearl/setup update --local')).toBeInTheDocument();
  });

  it('installs a new catalog tool through the published Skill interface without a host capability flag', async () => {
    const tool = {
      id: 'plugin:sample',
      plugin: 'sample',
      repository: 'team/tools',
      skill: 'sample-tool',
      title: 'Sample tool',
      description: 'Sample',
      icon: 'package',
    };
    mocks.catalog.mockReturnValue({ tools: [tool], loading: false, failed: false, retry: vi.fn() });
    let installed = false;
    mocks.list.mockImplementation(async () => ({
      tools: installed ? [{ id: tool.id, plugin: tool.plugin, title: tool.title, order: 100 }] : [],
    }));
    mocks.native.mockImplementation(async (action: string, input?: unknown) => {
      expect(action).toBe('agent_skills_install');
      expect(input).toEqual({
        providerId: 'codex',
        source: 'team/tools',
        name: 'sample-tool',
        scope: 'global',
      });
      installed = true;
      return { ok: true, output: 'installed' };
    });
    render(<Toolbox />);
    await screen.findByText('toolboxNoInstalledTools');
    fireEvent.click(screen.getByRole('button', { name: 'toolboxInstallTools' }));
    const dialog = screen.getByRole('dialog', { name: 'toolboxInstallTools' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'toolboxInstallTool' }));
    await within(dialog).findByText('toolboxInstalled');
    expect(mocks.toast).toHaveBeenCalledWith('toolboxInstallSuccess', 'success');
    expect(mocks.list.mock.calls.every(([action]) => action === 'toolbox_tools_list')).toBe(true);
    expect(mocks.native).toHaveBeenCalledOnce();
    expect(within(dialog).queryByText('toolboxNativeHostUpdateDescription')).toBeNull();
  });

  it('keeps one install request in flight and does not report success without a registered toolbox tool', async () => {
    mocks.list.mockResolvedValue({ tools: [] });
    let finish!: (value: { ok: true; output: string }) => void;
    mocks.native.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    render(<Toolbox />);
    await screen.findByText('toolboxNoInstalledTools');
    fireEvent.click(screen.getByRole('button', { name: 'toolboxInstallTools' }));
    const dialog = screen.getByRole('dialog', { name: 'toolboxInstallTools' });
    const row = within(dialog).getByText('Image compression').closest('li')!;
    fireEvent.click(within(row).getByRole('button'));
    fireEvent.click(within(row).getByRole('button'));
    expect(mocks.native).toHaveBeenCalledOnce();
    await act(async () => finish({ ok: true, output: 'installed' }));
    expect(mocks.toast).toHaveBeenCalledWith('toolboxInstallListFailed', 'error');
    expect(mocks.toast).not.toHaveBeenCalledWith('toolboxInstallSuccess', 'success');
  });

  it('lists tools from the fourth position and keeps all tools in the sort dialog', async () => {
    const onToolsChange = vi.fn();
    render(<Toolbox requestCasesEnabled onToolsChange={onToolsChange} />);

    await screen.findByRole('button', { name: /Workspace Notes/ });
    expect(onToolsChange).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'plugin:notebook' })]),
    );
    expect(screen.queryByRole('button', { name: /popupToolFormatter/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /popupToolRules/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /popupToolBrowsers/ })).toBeNull();
    expect(screen.getByRole('button', { name: /toolboxDeviceCaptureTitle/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSort' }));
    expect(screen.getByRole('dialog', { name: 'toolboxSort' })).toHaveTextContent(
      'popupToolFormatter',
    );
    expect(screen.getByRole('dialog', { name: 'toolboxSort' })).toHaveTextContent('popupToolRules');
    expect(screen.getByRole('dialog', { name: 'toolboxSort' })).toHaveTextContent(
      'popupToolBrowsers',
    );
    expect(screen.getByRole('dialog', { name: 'toolboxSort' })).toHaveTextContent(
      'toolboxDeviceCaptureTitle',
    );
    expect(screen.getByRole('dialog', { name: 'toolboxSort' })).toHaveTextContent(
      'Workspace Notes',
    );
  });

  it('reorders built-in and plugin tools and restores the saved order', async () => {
    const onOrderChange = vi.fn();
    const { unmount } = render(<Toolbox requestCasesEnabled onOrderChange={onOrderChange} />);
    await screen.findByRole('button', { name: /Workspace Notes/ });
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSort' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'toolboxMoveUp' })[4]);
    const order = JSON.parse(window.localStorage.getItem('mearl.popup.toolbox.order') || '[]');
    expect(order).toHaveLength(5);
    expect(order[3]).toBe('plugin:notebook');
    expect(onOrderChange).toHaveBeenCalledWith(order);
    expect(screen.getByRole('button', { name: /Workspace Notes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /toolboxDeviceCaptureTitle/ })).toBeInTheDocument();
    unmount();
    render(<Toolbox requestCasesEnabled />);
    await screen.findByRole('button', { name: /Workspace Notes/ });
    expect(window.localStorage.getItem('mearl.popup.toolbox.order')).toBe(JSON.stringify(order));
    const titles = [...document.querySelectorAll('ul > li > button')].map(
      button => button.textContent,
    );
    expect(titles[0]).toContain('Workspace Notes');
    expect(titles[1]).toContain('toolboxDeviceCaptureTitle');
  });

  it('resets the saved order from the shared modal header', async () => {
    const onOrderChange = vi.fn();
    render(<Toolbox requestCasesEnabled onOrderChange={onOrderChange} />);
    await screen.findByRole('button', { name: /Workspace Notes/ });
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSort' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'toolboxMoveUp' })[4]);

    fireEvent.click(screen.getByRole('button', { name: 'toolboxSortReset' }));

    expect(window.localStorage.getItem('mearl.popup.toolbox.order')).toBeNull();
    expect(onOrderChange).toHaveBeenLastCalledWith([]);
    const titles = [...document.querySelectorAll('ul > li > button')].map(
      button => button.textContent,
    );
    expect(titles[0]).toContain('toolboxDeviceCaptureTitle');
    expect(titles[1]).toContain('Workspace Notes');
  });

  it('shows only tools after the direct navigation slots', async () => {
    const onSelectBuiltIn = vi.fn();
    render(<Toolbox requestCasesEnabled onSelectBuiltIn={onSelectBuiltIn} />);
    await screen.findByRole('button', { name: /Workspace Notes/ });
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSort' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'toolboxMoveUp' })[4]);
    fireEvent.click(screen.getAllByRole('button', { name: 'toolboxMoveUp' })[3]);
    fireEvent.click(screen.getByTitle('Close (ESC)'));

    expect(screen.queryByRole('button', { name: /Workspace Notes/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /popupToolBrowsers/ }));
    expect(onSelectBuiltIn).toHaveBeenCalledExactlyOnceWith('browsers');
  });

  it('persists the header divider, restores it and resets it with the order', async () => {
    const onPinnedCountChange = vi.fn();
    const { unmount } = render(
      <Toolbox requestCasesEnabled onPinnedCountChange={onPinnedCountChange} />,
    );
    await screen.findByRole('button', { name: /Workspace Notes/ });
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSort' }));
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Home' });
    expect(window.localStorage.getItem('mearl.popup.toolbox.pinnedCount')).toBe('0');
    expect(onPinnedCountChange).toHaveBeenLastCalledWith(0);
    unmount();

    render(<Toolbox requestCasesEnabled onPinnedCountChange={onPinnedCountChange} />);
    await screen.findByRole('button', { name: /Workspace Notes/ });
    expect(screen.getByRole('button', { name: /popupToolFormatter/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSort' }));
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '0');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
    expect(window.localStorage.getItem('mearl.popup.toolbox.pinnedCount')).toBe('5');
    expect(screen.getByText('toolboxAllToolsInHeader')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSortReset' }));
    expect(window.localStorage.getItem('mearl.popup.toolbox.pinnedCount')).toBeNull();
    expect(onPinnedCountChange).toHaveBeenLastCalledWith(3);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '3');
  });

  it('opens built-in and plugin tools inside the popup before offering a tab', async () => {
    const { container } = render(<Toolbox requestCasesEnabled />);

    fireEvent.click(screen.getByRole('button', { name: /toolboxDeviceCaptureTitle/ }));
    expect(await screen.findByTestId('device-capture')).toBeInTheDocument();
    expect(mocks.openPlugin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'capture-back' }));

    fireEvent.click(await screen.findByRole('button', { name: /Workspace Notes/ }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith('toolbox_tool_open', { id: 'plugin:notebook' }),
    );
    expect(await screen.findByTestId('sandbox-tool')).toHaveAttribute('data-embedded', 'true');
    expect(mocks.openPlugin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'sandbox-select' }));
    fireEvent.click(screen.getByRole('button', { name: 'sandbox-open-tab' }));
    await waitFor(() =>
      expect(mocks.openPlugin).toHaveBeenCalledExactlyOnceWith('plugin:notebook', {
        id: 'notebook-id',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'sandbox-back' }));
    expect(await screen.findByRole('button', { name: /Workspace Notes/ })).toBeInTheDocument();
    expect(container.querySelector('.lucide-external-link')).toBeNull();
    expect(window.close).not.toHaveBeenCalled();
  });

  it.each(['popup', 'tab', 'both'] as const)('honors the %s display mode', async displayMode => {
    const original = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementation(async (action: string) => {
      const result = await original(action);
      return action === 'toolbox_tool_open' ? { ...result, displayMode } : result;
    });
    render(<Toolbox />);
    fireEvent.click(await screen.findByRole('button', { name: /Workspace Notes/ }));
    if (displayMode === 'tab') {
      await waitFor(() =>
        expect(mocks.openPlugin).toHaveBeenCalledExactlyOnceWith('plugin:notebook', {}),
      );
      expect(screen.queryByTestId('sandbox-tool')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(window.localStorage.getItem('mearl.popup.toolbox.activeTool')).toBeNull(),
      );
    } else {
      await screen.findByTestId('sandbox-tool');
      expect(Boolean(screen.queryByRole('button', { name: 'sandbox-open-tab' }))).toBe(
        displayMode === 'both',
      );
      expect(mocks.openPlugin).not.toHaveBeenCalled();
    }
  });

  it('switches directly between plugin and capture tools and marks the current selection', async () => {
    render(<Toolbox requestCasesEnabled onSelectBuiltIn={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Workspace Notes/ }));
    await screen.findByTestId('sandbox-tool');
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([
      'toolboxDeviceCaptureTitle',
      'Workspace Notes',
    ]);
    expect(screen.getByRole('menuitemradio', { name: 'Workspace Notes' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'toolboxDeviceCaptureTitle' }));
    expect(screen.getByTestId('device-capture')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    expect(
      screen.getByRole('menuitemradio', { name: 'toolboxDeviceCaptureTitle' }),
    ).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Workspace Notes' }));
    await screen.findByTestId('sandbox-tool');
    expect(mocks.list.mock.calls.filter(([action]) => action === 'toolbox_tool_open')).toHaveLength(
      2,
    );
  });

  it('limits the switch menu to the toolbox list after custom ordering', async () => {
    window.localStorage.setItem(
      'mearl.popup.toolbox.order',
      JSON.stringify([
        'builtin:formatter',
        'builtin:rules',
        'plugin:notebook',
        'builtin:capture',
        'builtin:browsers',
      ]),
    );
    render(
      <Toolbox
        requestCasesEnabled
        onSelectBuiltIn={vi.fn()}
        initialSelectionOverride={{
          kind: 'plugin',
          id: 'plugin:notebook',
          title: 'Workspace Notes',
        }}
      />,
    );
    await screen.findByTestId('sandbox-tool');
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([
      'toolboxDeviceCaptureTitle',
      'popupToolBrowsers',
    ]);
  });

  it('switches directly to another plugin and uses its display mode', async () => {
    const original = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementation(async (action: string, input?: { id: string }) => {
      const result = await original(action);
      if (action === 'toolbox_tools_list')
        return {
          tools: [
            ...result.tools,
            { id: 'plugin:other', plugin: 'other', title: 'Other tool', displayMode: 'tab' },
          ],
        };
      return input?.id === 'plugin:other'
        ? { ...result, title: 'Other tool', displayMode: 'tab' }
        : { ...result, displayMode: 'popup' };
    });
    render(
      <Toolbox
        directEntry
        initialSelectionOverride={{
          kind: 'plugin',
          id: 'plugin:notebook',
          title: 'Workspace Notes',
        }}
      />,
    );
    await screen.findByTestId('sandbox-tool');
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Workspace Notes' }));
    expect(mocks.list.mock.calls.filter(([action]) => action === 'toolbox_tool_open')).toHaveLength(
      1,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Other tool' }));
    await waitFor(() =>
      expect(mocks.openPlugin).toHaveBeenCalledExactlyOnceWith('plugin:other', {}),
    );
  });

  it('ignores a pending plugin result after switching to capture', async () => {
    const original = mocks.list.getMockImplementation()!;
    let resolveOpen!: (value: Awaited<ReturnType<typeof original>>) => void;
    mocks.list.mockImplementation((action: string) =>
      action === 'toolbox_tool_open'
        ? new Promise(resolve => {
            resolveOpen = resolve;
          })
        : original(action),
    );
    render(<Toolbox requestCasesEnabled />);
    fireEvent.click(await screen.findByRole('button', { name: /Workspace Notes/ }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'toolboxDeviceCaptureTitle' }));
    await act(async () => resolveOpen(await original('toolbox_tool_open')));
    expect(screen.getByTestId('device-capture')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-tool')).not.toBeInTheDocument();
  });

  it('redirects a restored tab-only tool with its saved query', async () => {
    const original = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementation(async (action: string) => {
      const result = await original(action);
      return action === 'toolbox_tool_open' ? { ...result, displayMode: 'tab' } : result;
    });
    window.localStorage.setItem(
      'mearl.popup.toolbox.activeTool',
      JSON.stringify({
        kind: 'plugin',
        id: 'plugin:notebook',
        title: 'Workspace Notes',
        query: { id: 'notebook-id' },
      }),
    );
    render(<Toolbox />);
    await waitFor(() =>
      expect(mocks.openPlugin).toHaveBeenCalledExactlyOnceWith('plugin:notebook', {
        id: 'notebook-id',
      }),
    );
    expect(screen.queryByTestId('sandbox-tool')).not.toBeInTheDocument();
  });

  it('rejects popup-only tools in the standalone toolbox', async () => {
    const original = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementation(async (action: string) => {
      const result = await original(action);
      return action === 'toolbox_tool_open' ? { ...result, displayMode: 'popup' } : result;
    });
    render(<Toolbox surface="tab" />);
    fireEvent.click(await screen.findByRole('button', { name: /Workspace Notes/ }));
    await waitFor(() => expect(screen.getByText('toolboxUnavailable')).toBeInTheDocument());
    expect(screen.queryByTestId('sandbox-tool')).not.toBeInTheDocument();
    expect(mocks.openPlugin).not.toHaveBeenCalled();
  });

  it('only shows a list refresh toast for an explicit refresh', async () => {
    render(<Toolbox />);
    await screen.findByRole('button', { name: /Workspace Notes/ });
    expect(mocks.toast).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'toolboxRefresh' }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('toolboxRefreshSuccess', 'success'),
    );
  });

  it.each(['toolboxRefresh', 'toolboxPluginUpdate'])(
    'shows a failure toast for %s',
    async button => {
      render(<Toolbox />);
      await screen.findByRole('button', { name: /Workspace Notes/ });
      if (button === 'toolboxPluginUpdate')
        mocks.native.mockRejectedValueOnce(new Error('disconnected'));
      else mocks.list.mockRejectedValueOnce(new Error('disconnected'));
      fireEvent.click(screen.getByRole('button', { name: button }));
      await waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
          button === 'toolboxRefresh' ? 'toolboxRefreshFailed' : 'toolboxSkillUpdateFailed',
          'error',
        ),
      );
      expect(screen.getByText('toolboxUnavailable')).toBeInTheDocument();
    },
  );

  it('restores the last opened tool and its query when the popup opens again', async () => {
    window.localStorage.setItem(
      'mearl.popup.toolbox.activeTool',
      JSON.stringify({
        kind: 'plugin',
        id: 'plugin:notebook',
        title: 'Workspace Notes',
        query: { id: 'notebook-id' },
      }),
    );

    render(<Toolbox requestCasesEnabled />);

    expect(await screen.findByTestId('sandbox-tool')).toHaveAttribute(
      'data-query',
      JSON.stringify({ id: 'notebook-id' }),
    );
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith('toolbox_tool_open', { id: 'plugin:notebook' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'sandbox-open-tab' }));
    await waitFor(() =>
      expect(mocks.openPlugin).toHaveBeenCalledExactlyOnceWith('plugin:notebook', {
        id: 'notebook-id',
      }),
    );
  });

  it('opens a tool from the header without a back button', async () => {
    render(
      <Toolbox
        requestCasesEnabled
        directEntry
        initialSelectionOverride={{
          kind: 'plugin',
          id: 'plugin:notebook',
          title: 'Workspace Notes',
        }}
      />,
    );

    expect(await screen.findByTestId('sandbox-tool')).toHaveAttribute('data-has-back', 'false');
    expect(screen.queryByRole('button', { name: 'toolboxBack' })).toBeNull();
    expect(window.localStorage.getItem('mearl.popup.toolbox.activeTool')).toBeNull();
  });

  it('checks and updates a plugin before uninstalling from its row actions', async () => {
    let installed = true;
    mocks.list.mockImplementation(async (action: string) => {
      if (action === 'toolbox_plugin_uninstall') {
        installed = false;
        return { plugin: 'notebook', removed: true };
      }
      return {
        tools: installed
          ? [
              {
                id: 'plugin:notebook',
                plugin: 'notebook',
                title: 'Workspace Notes',
                skillUpdate: { name: 'notebook-skill', scope: 'global' },
                order: 100,
              },
            ]
          : [],
      };
    });
    render(<Toolbox requestCasesEnabled />);

    expect(await screen.findByRole('button', { name: 'toolboxPluginUpdate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'toolboxInstallTools' }).textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'toolboxPluginUninstall' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /toolboxDeviceCaptureTitle/ }).parentElement,
    ).not.toContainElement(screen.getByRole('button', { name: 'toolboxPluginUpdate' }));

    fireEvent.click(screen.getByRole('button', { name: 'toolboxPluginUpdate' }));
    await waitFor(() =>
      expect(mocks.native).toHaveBeenCalledWith('agent_skills_update', {
        providerId: 'codex',
        name: 'notebook-skill',
        scope: 'global',
      }),
    );
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('toolboxPluginUpdateSuccess', 'success');
    fireEvent.click(screen.getByRole('button', { name: 'toolboxPluginUninstall' }));
    expect(screen.getByText('toolboxPluginUninstallConfirmInline')).toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalledWith('toolbox_plugin_uninstall', {
      id: 'plugin:notebook',
    });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByText('toolboxPluginUninstallConfirmInline')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'toolboxPluginUninstall' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith('toolbox_plugin_uninstall', {
        id: 'plugin:notebook',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Workspace Notes/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'toolboxInstallTools' })).toHaveTextContent(
      'toolboxInstallTools',
    );
    expect(window.close).not.toHaveBeenCalled();
  });

  it('reports an up-to-date tool without downloading or reloading it', async () => {
    mocks.native.mockResolvedValue({
      updates: [
        { name: 'another-skill', scope: 'global' },
        { name: 'notebook-skill', scope: 'project' },
      ],
    });
    render(<Toolbox />);
    fireEvent.click(await screen.findByRole('button', { name: 'toolboxPluginUpdate' }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith('toolboxPluginUpToDate', 'success'),
    );
    expect(mocks.native).toHaveBeenCalledExactlyOnceWith('agent_skills_check_updates', {
      providerId: 'codex',
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'toolboxPluginUpdate' })).not.toBeDisabled();
  });

  it('reports a completed update separately when refreshing the list fails', async () => {
    render(<Toolbox />);
    const button = await screen.findByRole('button', { name: 'toolboxPluginUpdate' });
    mocks.list.mockRejectedValueOnce(new Error('list unavailable'));
    fireEvent.click(button);
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith('toolboxPluginUpdateListFailed', 'error'),
    );
    expect(mocks.native).toHaveBeenCalledWith('agent_skills_update', {
      providerId: 'codex',
      name: 'notebook-skill',
      scope: 'global',
    });
    expect(mocks.toast).not.toHaveBeenCalledWith('toolboxSkillUpdateFailed', 'error');
    expect(screen.getByRole('button', { name: 'toolboxPluginUpdate' })).not.toBeDisabled();
  });

  it('keeps check and update progress visible, blocks duplicate clicks and restores controls after failure', async () => {
    let completeCheck!: (result: unknown) => void;
    let failUpdate!: (error: Error) => void;
    const check = new Promise(resolve => {
      completeCheck = resolve;
    });
    const update = new Promise((_resolve, reject) => {
      failUpdate = reject;
    });
    mocks.native.mockImplementation((action: string) =>
      action === 'agent_skills_check_updates' ? check : update,
    );
    render(<Toolbox />);
    const button = await screen.findByRole('button', { name: 'toolboxPluginUpdate' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole('status')).toHaveTextContent('toolboxPluginChecking');
    expect(screen.getByRole('button', { name: /Workspace Notes/ })).toBeDisabled();
    expect(mocks.native).toHaveBeenCalledTimes(1);
    await act(async () =>
      completeCheck({ updates: [{ name: 'notebook-skill', scope: 'global' }] }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('toolboxSkillUpdating');
    expect(screen.getByRole('button', { name: 'toolboxPluginUninstall' })).toBeDisabled();
    await act(async () => failUpdate(new Error('update failed')));
    expect(mocks.toast).toHaveBeenCalledWith('toolboxSkillUpdateFailed', 'error');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'toolboxPluginUpdate' })).not.toBeDisabled();
  });

  it('does not offer remote updates for a tool registered from a development directory', async () => {
    mocks.list.mockResolvedValue({
      tools: [{ id: 'plugin:local', plugin: 'local', title: 'Local Tool', order: 100 }],
    });
    render(<Toolbox />);
    await screen.findByRole('button', { name: /Local Tool/ });
    expect(screen.queryByRole('button', { name: 'toolboxPluginUpdate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'toolboxPluginUninstall' })).toBeInTheDocument();
    expect(mocks.native).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'])(
    'shows uninstall progress until %s and prevents opening the tool',
    async result => {
      let installed = true;
      let finish!: (value: { plugin: string; removed: boolean }) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise<{ plugin: string; removed: boolean }>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      mocks.list.mockImplementation(async (action: string) => {
        if (action === 'toolbox_plugin_uninstall') return pending;
        return {
          tools: installed
            ? [
                {
                  id: 'plugin:notebook',
                  plugin: 'notebook',
                  title: 'Workspace Notes',
                  order: 100,
                },
              ]
            : [],
        };
      });
      render(<Toolbox />);
      const openButton = await screen.findByRole('button', { name: 'Workspace Notes' });
      fireEvent.click(screen.getByRole('button', { name: 'toolboxPluginUninstall' }));
      fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('toolboxUninstalling');
      expect(status.parentElement).toBeDisabled();
      expect(status.parentElement?.querySelector('svg')).toHaveClass('animate-spin');
      expect(status.closest('div')).toHaveClass('opacity-100');
      expect(openButton).toBeDisabled();
      fireEvent.click(openButton);
      expect(mocks.list).not.toHaveBeenCalledWith('toolbox_tool_open', expect.anything());
      await act(async () => {
        if (result === 'success') {
          installed = false;
          finish({ plugin: 'notebook', removed: true });
        } else fail(new Error('Unable to uninstall'));
      });
      await waitFor(() => expect(screen.queryByText('toolboxUninstalling')).toBeNull());
      if (result === 'success')
        expect(screen.queryByRole('button', { name: 'Workspace Notes' })).toBeNull();
      else {
        expect(screen.getByRole('button', { name: 'Workspace Notes' })).not.toBeDisabled();
        expect(screen.getByRole('button', { name: 'toolboxPluginUninstall' })).not.toBeDisabled();
      }
    },
  );

  it('keeps the toolbox open and shows an error when a tool window cannot open', async () => {
    mocks.list.mockImplementation(async (action: string) => {
      if (action === 'toolbox_tool_open') throw new Error('window unavailable');
      return {
        tools: [
          {
            id: 'plugin:notebook',
            plugin: 'notebook',
            title: 'Workspace Notes',
            order: 100,
          },
        ],
      };
    });
    render(<Toolbox requestCasesEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: /Workspace Notes/ }));

    expect(await screen.findByText('toolboxUnavailable')).toBeInTheDocument();
    expect(window.close).not.toHaveBeenCalled();
  });

  it('delays the loading indicator so fast requests do not flicker', () => {
    vi.useFakeTimers();
    mocks.list.mockReturnValue(new Promise(() => {}));
    render(<Toolbox requestCasesEnabled />);

    const refreshButton = screen.getByRole('button', { name: 'toolboxRefresh' });
    expect(refreshButton).toHaveClass('disabled:cursor-default');
    expect(refreshButton).not.toHaveClass('disabled:cursor-wait');
    expect(screen.queryByText('toolboxLoading')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByText('toolboxLoading')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    const loading = screen.getByRole('status');
    expect(loading).toHaveTextContent('toolboxLoading');
    expect(loading.querySelector('svg')).toHaveClass('animate-spin');
    expect(loading.querySelector('svg')).not.toHaveClass('motion-reduce:animate-none');
  });

  it('delays the tool opening indicator and cancels it when navigating back', async () => {
    vi.useFakeTimers();
    mocks.list.mockImplementation((action: string) =>
      action === 'toolbox_tool_open' ? new Promise(() => {}) : Promise.resolve({ tools: [] }),
    );
    render(
      <Toolbox
        requestCasesEnabled
        initialSelectionOverride={{
          kind: 'plugin',
          id: 'plugin:notebook',
          title: 'Workspace Notes',
        }}
      />,
    );
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Workspace Notes' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByText('toolboxToolOpening')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status')).toHaveTextContent('toolboxToolOpening');
    fireEvent.click(screen.getByRole('button', { name: 'toolboxBack' }));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByText('toolboxToolOpening')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not flash the tool opening indicator when the tool is ready quickly', async () => {
    vi.useFakeTimers();
    render(
      <Toolbox
        requestCasesEnabled
        initialSelectionOverride={{
          kind: 'plugin',
          id: 'plugin:notebook',
          title: 'Workspace Notes',
        }}
      />,
    );
    expect(screen.queryByText('toolboxToolOpening')).not.toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByTestId('sandbox-tool')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByText('toolboxToolOpening')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'shows directory provenance and source-specific cache status (pending %s, cached %s)',
    async (pendingPriority, usingCache) => {
      const repository = 'git@code.example.test:team/skills.git#release/v3';
      const tool = {
        ...catalogFixture.tools[0],
        id: 'plugin:team-tool',
        plugin: 'team-tool',
        repository,
        skill: 'team-skill',
        title: 'Team tool',
        locales: undefined,
      };
      const source = { id: 'team', url: 'https://team.example/tools.json', label: 'Team' };
      mocks.catalog.mockReturnValue({
        tools: [tool],
        groups: [{ source, tools: [tool], pendingPriority }],
        issues: [
          {
            source: { id: 'unavailable', label: 'Unavailable' },
            reason: 'unavailable',
            usingCache,
          },
        ],
        loading: false,
        failed: true,
        retry: vi.fn(),
      });
      mocks.list.mockResolvedValue({ tools: [] });
      render(<Toolbox />);
      await screen.findByText('toolboxNoInstalledTools');
      fireEvent.click(screen.getByRole('button', { name: 'toolboxInstallTools' }));
      const dialog = screen.getByRole('dialog', { name: 'toolboxInstallTools' });
      expect(
        within(dialog).getByRole('region', { name: `Team · ${repository}` }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(
          usingCache ? 'toolboxCatalogSourceCached' : 'toolboxCatalogSourceFailed',
        ),
      ).toBeInTheDocument();
      expect(
        within(dialog).queryByText(
          usingCache ? 'toolboxCatalogSourceFailed' : 'toolboxCatalogSourceCached',
        ),
      ).not.toBeInTheDocument();
      const install = within(within(dialog).getByText('Team tool').closest('li')!).getByRole(
        'button',
      );
      if (pendingPriority) {
        expect(install).toBeDisabled();
        expect(mocks.native).not.toHaveBeenCalledWith('agent_skills_install', expect.anything());
        return;
      }
      fireEvent.click(install);
      await waitFor(() =>
        expect(mocks.native).toHaveBeenCalledWith(
          'agent_skills_install',
          expect.objectContaining({ source: repository, name: 'team-skill' }),
        ),
      );
    },
  );
});
