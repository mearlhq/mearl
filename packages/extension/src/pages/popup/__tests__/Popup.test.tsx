import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolboxPluginTool } from '@mearl/browser-core';
import { Popup } from '../Popup';
import type { ExtensionConfig } from '../../panel/utils/config';
import { cacheToolboxNavigation } from '../toolboxNavigationCache';

const bootstrapConfig: ExtensionConfig = {
  language: 'en',
  sseMonitoringEnabled: true,
  agentEnabled: true,
  agentPreventForeground: false,
  agentFloatingButtonEnabled: false,
  globalTranslation: 'none',
  accountsEnabled: false,
  requestCasesEnabled: true,
  requestMetadataEnabled: true,
  requestImportEnabled: true,
  trackingMetadataEnabled: true,
  queryPresets: [],
  seenBuiltinPresetIds: [],
};

const openSidePanel = vi.fn();
const configMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));
const jsonInputMocks = vi.hoisted(() => ({
  inputText: '',
  isInitialized: true,
  processInputText: vi.fn(),
  setInputText: vi.fn(),
}));
const undoMocks = vi.hoisted(() => ({
  pushSnapshot: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
}));
const clipboardMocks = vi.hoisted(() => ({
  readClipboardContent: vi.fn(),
}));
const qrDecoderMocks = vi.hoisted(() => ({
  decodeQrCodeFromImage: vi.fn(),
}));
const toastMocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));
const toolboxMocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('../../../shared/agentSidePanelState', () => ({
  agentSidePanelShortcutLabel: () => 'Shortcut',
}));

vi.mock('../../panel/utils/config', async importOriginal => ({
  ...(await importOriginal<typeof import('../../panel/utils/config')>()),
  getConfig: configMocks.getConfig,
  onConfigChange: vi.fn(() => () => {}),
}));

vi.mock('../../panel/utils/i18n', () => ({
  initI18n: vi.fn(async () => {}),
  getCurrentLanguage: () => 'en',
  t: (key: string) => key,
}));

vi.mock('../hooks/useJsonInput', () => ({
  useJsonInput: () => ({
    inputText: jsonInputMocks.inputText,
    setInputText: jsonInputMocks.setInputText,
    parseError: null,
    isStandalonePage: false,
    isInitialized: jsonInputMocks.isInitialized,
    processInputText: jsonInputMocks.processInputText,
  }),
}));

vi.mock('../hooks/useUndoHistory', () => ({
  useUndoHistory: () => ({
    pushSnapshot: undoMocks.pushSnapshot,
    undo: undoMocks.undo,
    redo: undoMocks.redo,
  }),
}));

vi.mock('../../panel/utils/clipboard', () => ({
  copySvgImageToClipboard: vi.fn(),
  copyToClipboard: vi.fn(),
  readClipboardContent: clipboardMocks.readClipboardContent,
}));

vi.mock('../../../shared/qrCodeDecoder', () => ({
  decodeQrCodeFromImage: qrDecoderMocks.decodeQrCodeFromImage,
}));

vi.mock('../../panel/utils/toast', () => ({ showToast: toastMocks.showToast }));
vi.mock('../toolboxRequest', () => ({ requestToolbox: toolboxMocks.list }));

vi.mock('../../panel/hooks/useSearchUI', () => ({
  useSearchUI: () => ({
    searchQuery: '',
    setSearchQuery: vi.fn(),
    currentMatchIndex: 0,
    matchNavigationVersion: 0,
    totalMatches: 0,
    setTotalMatches: vi.fn(),
    showSearch: false,
    setShowSearch: vi.fn(),
    searchInputRef: { current: null },
    handleNextMatch: vi.fn(),
    handlePrevMatch: vi.fn(),
    handleClose: vi.fn(),
  }),
}));

vi.mock('../../panel/hooks/useAgentBridgeStatus', () => ({
  useAgentBridgeStatus: () => ({ agentConnected: false }),
}));

vi.mock('../../panel/hooks/useCloudConnectorStatus', () => ({
  useCloudConnectorStatus: () => ({ state: { connected: false } }),
}));

vi.mock('../../panel/components/json-tree/JsonTree', async () => {
  const { createElement, useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    JsonTree: ({ data, onParsed, onInteractionChange }: any) => {
      useEffect(() => {
        onParsed?.({
          parsed: { protocol: 'https:', host: 'example.com', pathname: '/' },
          format: { id: 'url', serialize: () => data },
        });
      }, [data, onParsed]);

      return createElement(
        'div',
        null,
        createElement(
          'button',
          { onClick: () => onInteractionChange?.({ type: 'add', path: [] }) },
          'start add item',
        ),
        createElement('button', { onClick: () => onInteractionChange?.(null) }, 'finish add item'),
        createElement(
          'button',
          { onClick: () => onInteractionChange?.({ type: 'edit', path: ['id'] }) },
          'start edit item',
        ),
        createElement('button', { onClick: () => onInteractionChange?.(null) }, 'finish edit item'),
      );
    },
  };
});
vi.mock('../../panel/components/detail/SearchBar', () => ({ SearchBar: () => null }));
vi.mock('../../panel/components/JsonKeyboardHints', () => ({
  JsonKeyboardHints: () => null,
}));
vi.mock('../../sidepanel/SidepanelChat', () => ({
  SidepanelChat: ({
    windowId,
    footerAction,
  }: {
    windowId: number | null;
    footerAction?: (flushDraft: () => void) => ReactNode;
  }) => (
    <div>
      <footer>{footerAction?.(() => {})}</footer>
      <div data-window-id={windowId}>agent chat content</div>
    </div>
  ),
}));
vi.mock('../../panel/components/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('../../panel/components/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('../../panel/components/AgentStatusModal', () => ({
  AgentStatusModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => (
    <div data-testid="agent-status-modal" data-open={isOpen}>
      <button type="button" onClick={onClose}>
        close agent modal
      </button>
    </div>
  ),
}));
vi.mock('../../panel/components/header/AccountBadge', () => ({
  AccountBadge: () => null,
}));
vi.mock('../../panel/components/header/Banner', () => ({ Banner: () => null }));
vi.mock('../../panel/components/header/QuickSettingsMenu', () => ({
  QuickSettingsMenu: () => null,
}));
vi.mock('../../panel/hooks/useRemoteConfig', () => ({ useRemoteConfig: () => null }));
vi.mock('../components/UrlQueryPresetButton', () => ({ UrlQueryPresetButton: () => null }));
vi.mock('../components/BrowserManager', () => ({
  BrowserManager: ({
    onBack,
    headerActions,
  }: {
    onBack?: () => void;
    headerActions?: ReactNode;
  }) => (
    <div>
      browser manager content
      {onBack && (
        <button aria-label="toolboxBack" onClick={onBack}>
          back
        </button>
      )}
      {headerActions}
    </div>
  ),
}));
vi.mock('../components/DeviceCaptureEntry', () => ({
  DeviceCaptureEntry: () => <div>device capture content</div>,
}));
vi.mock('../components/Toolbox', async importOriginal => ({
  ...(await importOriginal<typeof import('../components/Toolbox')>()),
  clearStoredToolboxSelection: () =>
    window.localStorage.removeItem('mearl.popup.toolbox.activeTool'),
  Toolbox: ({
    initialSelectionOverride,
    directEntry,
    onSelectionChange,
    onSelectBuiltIn,
    onPinnedCountChange,
    onToolsChange,
  }: {
    initialSelectionOverride?: { id?: string } | null;
    directEntry?: boolean;
    onSelectionChange?: (toolId: string | null) => void;
    onSelectBuiltIn?: (view: 'chat' | 'rules' | 'browsers') => void;
    onPinnedCountChange?: (count: number) => void;
    onToolsChange?: (tools: ToolboxPluginTool[]) => void;
  }) => (
    <div
      data-selected-tool={initialSelectionOverride?.id ?? ''}
      data-initial-selection={
        initialSelectionOverride === undefined
          ? 'stored'
          : initialSelectionOverride === null
            ? 'list'
            : 'direct'
      }
      data-direct-entry={String(Boolean(directEntry))}
    >
      toolbox content
      <button onClick={() => onSelectBuiltIn?.('chat')}>open hidden chat</button>
      <button onClick={() => onSelectBuiltIn?.('rules')}>open hidden rules</button>
      <button onClick={() => onSelectBuiltIn?.('browsers')}>open hidden browsers</button>
      <button onClick={() => onSelectionChange?.('plugin:notebook')}>select-tool</button>
      <button onClick={() => onSelectionChange?.(null)}>back-to-tools</button>
      <button onClick={() => onPinnedCountChange?.(1)}>pin-one-tool</button>
      <button onClick={async () => onToolsChange?.((await toolboxMocks.list()).tools)}>
        load-tools
      </button>
    </div>
  ),
}));
vi.mock('../../options/components/RulesEditor', () => ({
  default: ({ onBack, headerActions }: { onBack?: () => void; headerActions?: ReactNode }) => (
    <div>
      request rules content
      {onBack && (
        <button aria-label="toolboxBack" onClick={onBack}>
          back
        </button>
      )}
      {headerActions}
    </div>
  ),
}));

describe('Popup Agent side panel shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jsonInputMocks.inputText = '';
    jsonInputMocks.isInitialized = true;
    configMocks.getConfig.mockReset().mockResolvedValue({
      language: 'en',
      accountsEnabled: false,
      requestCasesEnabled: true,
      agentEnabled: true,
    });
    openSidePanel.mockReset().mockResolvedValue(undefined);
    chrome.sidePanel = { ...chrome.sidePanel, open: openSidePanel };
    clipboardMocks.readClipboardContent.mockResolvedValue({ text: null, image: null });
    qrDecoderMocks.decodeQrCodeFromImage.mockResolvedValue({
      success: false,
      error: 'not_found',
    });
    toolboxMocks.list.mockReset().mockResolvedValue({ tools: [] });
    chrome.windows = {
      getLastFocused: vi.fn().mockResolvedValue({ id: 17 }),
      create: vi.fn().mockResolvedValue({ id: 18 }),
    } as any;
    chrome.tabs = {
      create: vi.fn().mockResolvedValue({ id: 19 }),
    } as unknown as typeof chrome.tabs;
    chrome.runtime.getURL = vi.fn(
      path => `chrome-extension://extension-id/${path}`,
    ) as typeof chrome.runtime.getURL;
    vi.spyOn(window, 'close').mockImplementation(() => {});
    window.history.replaceState({}, '', '/');
    window.localStorage.clear();
  });

  it('does not render the welcome content before the input source is resolved', () => {
    jsonInputMocks.inputText = '{"api":"mtop.devtools.welcome.get"}';
    jsonInputMocks.isInitialized = false;

    render(<Popup />);

    expect(screen.queryByText('start add item')).not.toBeInTheDocument();
  });

  it('keeps formatter tools hidden before the input has been parsed', () => {
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    expect(screen.getByTestId('formatter-tools')).toHaveClass('opacity-0');
    expect(screen.getByTestId('formatter-tools')).not.toHaveClass('opacity-100');
  });

  it('uses a fixed viewport for the Chrome popup to avoid resize feedback', () => {
    const { container } = render(<Popup bootstrapConfig={bootstrapConfig} />);

    expect(container.firstElementChild).toHaveStyle({ width: '680px', height: '560px' });
  });

  it('opens the shared chat and shows the side-panel shortcut only there', async () => {
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    expect(
      screen.queryByRole('button', { name: 'openAgentSidePanelFromPage' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'agentChatTitle' }));
    const shortcut = await screen.findByRole('button', { name: 'openAgentSidePanelFromPage' });
    expect(shortcut).toHaveTextContent('Shortcut agentChatSidePanelLabel');
    expect(shortcut).toHaveAttribute('title', 'openAgentSidePanelFromPage (Shortcut)');
    const chat = await screen.findByText('agent chat content');
    await waitFor(() => expect(chat).toHaveAttribute('data-window-id', '17'));
    fireEvent.keyDown(document, { key: 'v', ctrlKey: true });
    expect(clipboardMocks.readClipboardContent).not.toHaveBeenCalled();
    expect(configMocks.getConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
    expect(
      screen.queryByRole('button', { name: 'openAgentSidePanelFromPage' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the side-panel shortcut absent when bootstrapped config disables Agent', () => {
    render(<Popup bootstrapConfig={{ ...bootstrapConfig, agentEnabled: false }} />);

    expect(screen.queryByRole('button', { name: 'agentChatTitle' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'openAgentSidePanelFromPage' }),
    ).not.toBeInTheDocument();
    expect(configMocks.getConfig).not.toHaveBeenCalled();
  });

  it('keeps the Agent modal mounted after its first open so it can finish closing', async () => {
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    fireEvent.click(screen.getByRole('button', { name: 'agent' }));
    expect(await screen.findByTestId('agent-status-modal')).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'close agent modal' }));
    expect(screen.getByTestId('agent-status-modal')).toHaveAttribute('data-open', 'false');
  });

  it('decodes a pasted image and displays its QR content', async () => {
    const image = new Blob(['qr'], { type: 'image/png' });
    clipboardMocks.readClipboardContent.mockResolvedValueOnce({ text: null, image });
    qrDecoderMocks.decodeQrCodeFromImage.mockResolvedValueOnce({
      success: true,
      text: 'https://example.com/from-qr',
    });
    render(<Popup />);

    fireEvent.keyDown(document, { key: 'v', ctrlKey: true });

    await waitFor(() =>
      expect(jsonInputMocks.processInputText).toHaveBeenCalledWith('https://example.com/from-qr'),
    );
    expect(qrDecoderMocks.decodeQrCodeFromImage).toHaveBeenCalledWith(image);
    expect(undoMocks.pushSnapshot).toHaveBeenCalledOnce();
    expect(toastMocks.showToast).toHaveBeenCalledWith('qrPasteDetected', 'success');
  });

  it('opens the side panel for the focused normal window before closing the popup', async () => {
    let finishOpening!: () => void;
    openSidePanel.mockReturnValueOnce(
      new Promise<void>(resolve => {
        finishOpening = resolve;
      }),
    );
    render(<Popup />);

    fireEvent.click(await screen.findByRole('button', { name: 'agentChatTitle' }));
    const button = await screen.findByRole('button', { name: 'openAgentSidePanelFromPage' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    expect(chrome.windows.getLastFocused).toHaveBeenCalledWith({ windowTypes: ['normal'] });
    expect(openSidePanel).toHaveBeenCalledWith({ windowId: 17 });
    expect(window.close).not.toHaveBeenCalled();
    await act(async () => finishOpening());
    expect(window.close).toHaveBeenCalledOnce();
  });

  it('keeps the popup open and allows retrying when the side panel fails to open', async () => {
    openSidePanel.mockRejectedValueOnce(new Error('open failed'));
    render(<Popup />);

    fireEvent.click(await screen.findByRole('button', { name: 'agentChatTitle' }));
    const button = await screen.findByRole('button', { name: 'openAgentSidePanelFromPage' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(toastMocks.showToast).toHaveBeenCalledWith('openAgentSidePanelFailed', 'error'),
    );
    expect(window.close).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(window.close).toHaveBeenCalledOnce());
    expect(openSidePanel).toHaveBeenCalledTimes(2);
  });

  it('hides the Agent side-panel shortcut when Agent service is disabled', async () => {
    configMocks.getConfig.mockResolvedValueOnce({
      language: 'en',
      accountsEnabled: false,
      requestCasesEnabled: true,
      agentEnabled: false,
    });
    render(<Popup />);

    await waitFor(() => expect(configMocks.getConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'openAgentSidePanelFromPage' })).toBeNull();
    expect(chrome.windows.getLastFocused).not.toHaveBeenCalled();
  });

  it('temporarily hides the QR code while an item is being added', async () => {
    jsonInputMocks.inputText = 'https://example.com/';
    render(<Popup />);

    expect(await screen.findByRole('img', { name: 'QR Code' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'start add item' }));
    expect(screen.queryByRole('img', { name: 'QR Code' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'finish add item' }));
    expect(await screen.findByRole('img', { name: 'QR Code' })).toBeInTheDocument();
  });

  it('temporarily hides the QR code while an item is being edited', async () => {
    jsonInputMocks.inputText = 'https://example.com/';
    render(<Popup />);

    expect(await screen.findByRole('img', { name: 'QR Code' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'start edit item' }));
    expect(screen.queryByRole('img', { name: 'QR Code' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'finish edit item' }));
    expect(await screen.findByRole('img', { name: 'QR Code' })).toBeInTheDocument();
  });

  it('switches between formatter, browser manager, request rules, and toolbox', async () => {
    toolboxMocks.list.mockResolvedValueOnce({
      tools: [
        {
          id: 'plugin:notebook',
          plugin: 'notebook',
          title: 'Workspace Notes',
          order: 100,
        },
      ],
    });
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    expect(screen.queryByRole('button', { name: 'popupToolBrowsers' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'popupToolToolbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'open hidden browsers' }));
    expect(await screen.findByText('browser manager content')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('popupToolBrowsers - Mearl'));
    fireEvent.click(screen.getByRole('button', { name: 'toolboxBack' }));

    fireEvent.click(screen.getByRole('button', { name: 'popupToolRules' }));
    const rulesContent = await screen.findByText('request rules content');
    expect(rulesContent).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('popupToolRules - Mearl'));

    fireEvent.click(await screen.findByRole('button', { name: 'popupToolToolbox' }));
    expect(screen.getByText('toolbox content')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('popupToolToolbox - Mearl'));

    fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
    expect(screen.queryByText('browser manager content')).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('popupToolFormatter - Mearl'));
  });

  it.each([0, 1, 8])('restores %s header tools and keeps the toolbox entry', async count => {
    window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', String(count));
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    expect(Boolean(screen.queryByRole('button', { name: 'popupToolFormatter' }))).toBe(count > 0);
    expect(Boolean(screen.queryByRole('button', { name: 'popupToolBrowsers' }))).toBe(count >= 4);
    expect(screen.getByRole('button', { name: 'popupToolToolbox' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'popupToolToolbox' }));
    fireEvent.click(await screen.findByRole('button', { name: 'pin-one-tool' }));
    expect(screen.getByRole('button', { name: 'popupToolFormatter' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'popupToolBrowsers' })).toBeNull();
  });

  it.each(['formatter', 'toolbox'])(
    'restores pinned plugin icons and selection before the host responds in %s',
    async view => {
      const tools: ToolboxPluginTool[] = [
        {
          id: 'plugin:notebook',
          plugin: 'notebook',
          title: 'Workspace Notes',
          icon: 'git-branch',
          order: 100,
        },
      ];
      cacheToolboxNavigation(tools);
      window.localStorage.setItem('mearl.popup.activeView', view);
      window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '1');
      window.localStorage.setItem('mearl.popup.toolbox.order', JSON.stringify(['plugin:notebook']));
      window.localStorage.setItem(
        'mearl.popup.toolbox.activeTool',
        JSON.stringify({
          kind: 'plugin',
          id: 'plugin:notebook',
          title: 'Workspace Notes',
          icon: 'git-branch',
        }),
      );
      let resolveList!: (result: { tools: ToolboxPluginTool[] }) => void;
      toolboxMocks.list.mockReturnValue(
        new Promise(resolve => {
          resolveList = resolve;
        }),
      );
      render(<Popup bootstrapConfig={bootstrapConfig} />);

      const pinned = screen.getByRole('button', { name: 'Workspace Notes' });
      const icon = pinned.querySelector('svg');
      expect(icon).toHaveClass('lucide-git-branch');
      expect(pinned).toHaveAttribute('aria-pressed', String(view === 'toolbox'));
      const entry = screen.getByRole('button', { name: 'popupToolToolbox' });
      expect(entry.querySelector('svg')).toHaveClass('lucide-wrench');
      expect(entry).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByRole('button', { name: 'popupToolFormatter' })).toBeNull();

      if (view === 'toolbox') fireEvent.click(screen.getByRole('button', { name: 'load-tools' }));
      await act(async () => resolveList({ tools }));
      expect(pinned.querySelector('svg')).toBe(icon);
      expect(entry.querySelector('svg')).toHaveClass('lucide-wrench');
    },
  );

  it('refreshes cached navigation and removes uninstalled tools after a successful response', async () => {
    cacheToolboxNavigation([
      {
        id: 'plugin:notebook',
        plugin: 'notebook',
        title: 'Workspace Notes',
        icon: 'git-branch',
        order: 100,
      },
    ]);
    window.localStorage.setItem('mearl.popup.toolbox.order', JSON.stringify(['plugin:notebook']));
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    expect(screen.getByRole('button', { name: 'Workspace Notes' })).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Workspace Notes' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'agentChatTitle' })).toBeInTheDocument();
    expect(window.localStorage.getItem('mearl.popup.toolbox.navigation')).toContain('"tools":[]');
  });

  it('keeps cached navigation when the host is temporarily unavailable', async () => {
    cacheToolboxNavigation([
      {
        id: 'plugin:notebook',
        plugin: 'notebook',
        title: 'Workspace Notes',
        icon: 'git-branch',
        order: 100,
      },
    ]);
    window.localStorage.setItem('mearl.popup.toolbox.order', JSON.stringify(['plugin:notebook']));
    toolboxMocks.list.mockRejectedValue(new Error('host unavailable'));
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Workspace Notes' })).toBeInTheDocument();
  });

  it('shows the first three sorted tools in the header and opens a plugin directly', async () => {
    window.localStorage.setItem(
      'mearl.popup.toolbox.order',
      JSON.stringify([
        'plugin:notebook',
        'builtin:formatter',
        'builtin:rules',
        'builtin:browsers',
        'builtin:capture',
      ]),
    );
    toolboxMocks.list.mockResolvedValue({
      tools: [{ id: 'plugin:notebook', plugin: 'notebook', title: 'Workspace Notes', order: 100 }],
    });
    window.localStorage.setItem(
      'mearl.popup.toolbox.activeTool',
      JSON.stringify({ kind: 'capture' }),
    );
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Workspace Notes' }));
    expect(screen.getByText('toolbox content')).toHaveAttribute(
      'data-selected-tool',
      'plugin:notebook',
    );
    expect(screen.getByText('toolbox content')).toHaveAttribute('data-direct-entry', 'true');
    expect(window.localStorage.getItem('mearl.popup.toolbox.activeTool')).toContain('capture');
    expect(screen.queryByRole('button', { name: 'popupToolBrowsers' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
    fireEvent.click(screen.getByRole('button', { name: 'popupToolToolbox' }));
    expect(screen.getByText('toolbox content')).toHaveAttribute('data-selected-tool', '');
    expect(screen.getByText('toolbox content')).toHaveAttribute('data-direct-entry', 'false');
    expect(screen.getByText('toolbox content')).toHaveAttribute('data-initial-selection', 'stored');
  });

  it.each(['saved', 'direct', 'list'])(
    'keeps a pinned plugin distinct from the toolbox when opened via %s',
    async source => {
      window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '6');
      toolboxMocks.list.mockResolvedValue({
        tools: [{ id: 'plugin:notebook', title: 'Workspace Notes', icon: 'git-branch' }],
      });
      if (source === 'saved') {
        window.localStorage.setItem('mearl.popup.activeView', 'toolbox');
        window.localStorage.setItem(
          'mearl.popup.toolbox.activeTool',
          JSON.stringify({ kind: 'plugin', id: 'plugin:notebook', title: 'Workspace Notes' }),
        );
      }
      render(<Popup bootstrapConfig={bootstrapConfig} />);
      if (source === 'saved') fireEvent.click(screen.getByRole('button', { name: 'load-tools' }));
      const pinned = await screen.findByRole('button', { name: 'Workspace Notes' });
      const toolbox = screen.getByRole('button', { name: 'popupToolToolbox' });
      if (source === 'direct') fireEvent.click(pinned);
      if (source === 'list') {
        fireEvent.click(toolbox);
        fireEvent.click(await screen.findByRole('button', { name: 'select-tool' }));
      }
      expect(pinned).toHaveAttribute('aria-pressed', 'true');
      expect(toolbox).toHaveAttribute('aria-pressed', 'false');
      expect(toolbox.querySelector('svg')).toHaveClass('lucide-wrench');
      expect(toolbox).toHaveAttribute('title', 'popupToolToolbox');
      expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);

      if (source === 'direct') {
        fireEvent.click(toolbox);
        expect(toolbox).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('toolbox content')).toHaveAttribute('data-direct-entry', 'false');
        return;
      }
      fireEvent.click(screen.getByRole('button', { name: 'pin-one-tool' }));
      expect(screen.queryByRole('button', { name: 'Workspace Notes' })).toBeNull();
      expect(toolbox.querySelector('svg')).toHaveClass('lucide-git-branch');
      expect(toolbox).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(toolbox);
      expect(toolbox.querySelector('svg')).toHaveClass('lucide-wrench');
      expect(screen.getByText('toolbox content')).toHaveAttribute('data-initial-selection', 'list');
    },
  );

  it('remembers the collapsed tool when switching to pinned plugins and built-in tools', async () => {
    window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '2');
    window.localStorage.setItem(
      'mearl.popup.toolbox.order',
      JSON.stringify(['plugin:notes', 'builtin:formatter']),
    );
    toolboxMocks.list.mockResolvedValue({
      tools: [
        { id: 'plugin:notes', title: 'Notes', icon: 'notebook-pen' },
        { id: 'plugin:notebook', title: 'Workspace Notes', icon: 'git-branch' },
      ],
    });
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    const notes = await screen.findByRole('button', { name: 'Notes' });
    const toolbox = screen.getByRole('button', { name: 'popupToolToolbox' });
    fireEvent.click(toolbox);
    fireEvent.click(await screen.findByRole('button', { name: 'select-tool' }));
    window.localStorage.setItem(
      'mearl.popup.toolbox.activeTool',
      JSON.stringify({ kind: 'plugin', id: 'plugin:notebook', title: 'Workspace Notes' }),
    );
    fireEvent.click(notes);
    expect(notes).toHaveAttribute('aria-pressed', 'true');
    expect(toolbox).toHaveAttribute('aria-pressed', 'false');
    expect(toolbox.querySelector('svg')).toHaveClass('lucide-git-branch');
    expect(toolbox).toHaveAttribute('title', 'Workspace Notes');
    fireEvent.click(screen.getByRole('button', { name: 'back-to-tools' }));
    expect(toolbox.querySelector('svg')).toHaveClass('lucide-git-branch');
    expect(screen.getByText('toolbox content')).toHaveAttribute('data-direct-entry', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'select-tool' }));
    expect(toolbox).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('toolbox content')).toHaveAttribute('data-direct-entry', 'false');
    expect(toolbox.querySelector('svg')).toHaveClass('lucide-git-branch');
    fireEvent.click(notes);
    fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
    expect(toolbox.querySelector('svg')).toHaveClass('lucide-git-branch');
    fireEvent.click(toolbox);
    expect(toolbox).toHaveAttribute('aria-pressed', 'true');
    expect(notes).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('toolbox content')).toHaveAttribute('data-initial-selection', 'stored');
    expect(window.localStorage.getItem('mearl.popup.toolbox.activeTool')).toContain(
      'plugin:notebook',
    );
  });

  it('restores the selected toolbox tool after switching to another view', async () => {
    toolboxMocks.list.mockResolvedValue({
      tools: [{ id: 'plugin:notebook', plugin: 'notebook', title: 'Workspace Notes', order: 100 }],
    });
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    fireEvent.click(await screen.findByRole('button', { name: 'popupToolToolbox' }));
    window.localStorage.setItem(
      'mearl.popup.toolbox.activeTool',
      JSON.stringify({ kind: 'plugin', id: 'plugin:notebook', title: 'Workspace Notes' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
    fireEvent.click(screen.getByRole('button', { name: 'popupToolToolbox' }));

    expect(screen.getByText('toolbox content')).toHaveAttribute('data-initial-selection', 'stored');
    expect(window.localStorage.getItem('mearl.popup.toolbox.activeTool')).toContain(
      'plugin:notebook',
    );
  });

  it('shows the active tool icon in the toolbox entry and restores the wrench on return', async () => {
    toolboxMocks.list.mockResolvedValue({
      tools: [{ id: 'plugin:notebook', title: 'Workspace Notes', icon: 'git-branch' }],
    });
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    fireEvent.click(await screen.findByRole('button', { name: 'popupToolToolbox' }));
    await screen.findByText('toolbox content');
    const entry = screen.getByRole('button', { name: 'popupToolToolbox' });
    expect(entry.querySelector('svg')).toHaveClass('lucide-wrench');
    fireEvent.click(screen.getByRole('button', { name: 'select-tool' }));
    await waitFor(() => expect(entry.querySelector('svg')).toHaveClass('lucide-git-branch'));
    expect(entry).toHaveAttribute('title', 'Workspace Notes');
    expect(entry).toHaveClass('bg-bg-primary');
    fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
    expect(entry.querySelector('svg')).toHaveClass('lucide-git-branch');
    expect(entry).not.toHaveClass('bg-bg-primary');
    fireEvent.click(entry);
    expect(entry.querySelector('svg')).toHaveClass('lucide-git-branch');
    fireEvent.click(screen.getByRole('button', { name: 'back-to-tools' }));
    expect(entry.querySelector('svg')).toHaveClass('lucide-wrench');
    expect(entry).toHaveAttribute('title', 'popupToolToolbox');
  });

  it('renders the selected custom SVG in the toolbox entry using the surrounding color', async () => {
    toolboxMocks.list.mockResolvedValue({
      tools: [
        {
          id: 'plugin:notebook',
          title: 'Workspace Notes',
          icon: '<svg fill="currentColor"><path d="M0 0h4v4H0z"/></svg>',
        },
      ],
    });
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    fireEvent.click(await screen.findByRole('button', { name: 'popupToolToolbox' }));
    fireEvent.click(await screen.findByRole('button', { name: 'select-tool' }));
    const entry = screen.getByRole('button', { name: 'popupToolToolbox' });
    await waitFor(() => expect(entry.querySelector('.bg-current')).toBeInTheDocument());
    expect((entry.querySelector('.bg-current') as HTMLElement).style.maskImage).toContain(
      'data:image/svg+xml,',
    );
  });

  it.each(['formatter', 'toolbox'])(
    'restores the tool icon on the first render in %s while metadata is pending',
    view => {
      window.localStorage.setItem('mearl.popup.activeView', view);
      window.localStorage.setItem(
        'mearl.popup.toolbox.activeTool',
        JSON.stringify({
          kind: 'plugin',
          id: 'plugin:notebook',
          title: 'Workspace Notes',
          icon: 'git-branch',
        }),
      );
      toolboxMocks.list.mockReturnValue(new Promise(() => {}));
      render(<Popup bootstrapConfig={bootstrapConfig} />);
      const entry = screen.getByRole('button', { name: 'popupToolToolbox' });
      expect(entry.querySelector('svg')).toHaveClass('lucide-git-branch');
      expect(entry).toHaveAttribute('title', 'Workspace Notes');
    },
  );

  it('keeps the toolbox entry when no plugin tools are registered', async () => {
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    expect(screen.queryByRole('button', { name: 'popupToolDeviceCapture' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'popupToolToolbox' }));

    expect(await screen.findByText('toolbox content')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('popupToolToolbox - Mearl'));
  });

  it('hides device capture and ignores a saved capture view when disabled', async () => {
    window.localStorage.setItem('mearl.popup.activeView', 'capture');
    render(<Popup bootstrapConfig={{ ...bootstrapConfig, requestCasesEnabled: false }} />);
    expect(screen.queryByRole('button', { name: 'popupToolDeviceCapture' })).toBeNull();
    expect(screen.queryByText('device capture content')).toBeNull();
    await waitFor(() => expect(document.title).toBe('popupToolFormatter - Mearl'));
  });

  it('shows the toolbox without waiting for the plugin list', () => {
    toolboxMocks.list.mockReturnValue(new Promise(() => {}));

    render(<Popup bootstrapConfig={bootstrapConfig} />);

    expect(screen.getByRole('button', { name: 'popupToolToolbox' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'popupToolDeviceCapture' })).toBeNull();
  });

  it('restores an empty toolbox without switching to device capture', async () => {
    window.localStorage.setItem('mearl.popup.activeView', 'toolbox');
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    expect(screen.getByRole('button', { name: 'popupToolToolbox' })).toBeInTheDocument();
    expect(await screen.findByText('toolbox content')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'popupToolDeviceCapture' })).toBeNull();
    expect(window.localStorage.getItem('mearl.popup.activeView')).toBe('toolbox');
  });

  it('opens the formatter full-page view in a bookmarkable tab', async () => {
    jsonInputMocks.inputText = '{"ok":true}';
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    fireEvent.click(await screen.findByTitle('openInNewTab'));

    await waitFor(() =>
      expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
        url: 'chrome-extension://extension-id/src/pages/popup/index.html?view=formatter&standalone=1',
        active: true,
      }),
    );
    expect(window.close).toHaveBeenCalledOnce();
  });

  it('restores the last selected popup mode and lets an explicit URL mode override it', async () => {
    const first = render(<Popup bootstrapConfig={bootstrapConfig} />);

    fireEvent.click(screen.getByRole('button', { name: 'popupToolRules' }));
    expect(window.localStorage.getItem('mearl.popup.activeView')).toBe('rules');
    first.unmount();

    const restored = render(<Popup bootstrapConfig={bootstrapConfig} />);
    expect(await screen.findByText('request rules content')).toBeInTheDocument();
    restored.unmount();

    window.history.replaceState({}, '', '?view=browsers');
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    expect(await screen.findByText('browser manager content')).toBeInTheDocument();
  });

  it.each(['rules', 'browsers'] as const)(
    'provides tool navigation for an unpinned built-in: %s',
    async view => {
      window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '1');
      window.localStorage.setItem('mearl.popup.activeView', 'toolbox');
      render(<Popup bootstrapConfig={bootstrapConfig} />);
      fireEvent.click(await screen.findByRole('button', { name: `open hidden ${view}` }));
      await screen.findByText(
        view === 'rules' ? 'request rules content' : 'browser manager content',
      );
      expect(screen.getByRole('button', { name: 'toolboxBack' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'toolboxSwitchTool' })).toBeInTheDocument();
      const entry = screen.getByRole('button', { name: 'popupToolToolbox' });
      expect(entry).toHaveAttribute('aria-pressed', 'true');
      expect(entry).toHaveAttribute(
        'title',
        view === 'rules' ? 'popupToolRules' : 'popupToolBrowsers',
      );
      fireEvent.click(screen.getByRole('button', { name: 'openInNewTab' }));
      await waitFor(() =>
        expect(chrome.tabs.create).toHaveBeenCalledWith({
          url: `chrome-extension://extension-id/src/pages/popup/index.html?view=${view}&standalone=1`,
          active: true,
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'toolboxBack' }));
      await screen.findByText('toolbox content');
      expect(screen.queryByRole('button', { name: 'toolboxBack' })).toBeNull();
      expect(entry.querySelector('svg')).toHaveClass('lucide-wrench');
    },
  );

  it.each(['rules', 'browsers'] as const)(
    'remembers the unpinned %s tool across formatter navigation',
    async view => {
      window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '1');
      window.localStorage.setItem('mearl.popup.activeView', 'toolbox');
      render(<Popup bootstrapConfig={bootstrapConfig} />);
      fireEvent.click(await screen.findByRole('button', { name: `open hidden ${view}` }));
      const content = view === 'rules' ? 'request rules content' : 'browser manager content';
      await screen.findByText(content);
      const entry = screen.getByRole('button', { name: 'popupToolToolbox' });
      const title = view === 'rules' ? 'popupToolRules' : 'popupToolBrowsers';
      fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
      expect(entry).toHaveAttribute('title', title);
      expect(entry).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(entry);
      expect(await screen.findByText(content)).toBeInTheDocument();
      expect(entry).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByText('toolbox content')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'toolboxBack' }));
      await screen.findByText('toolbox content');
      fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
      fireEvent.click(entry);
      expect(await screen.findByText('toolbox content')).toBeInTheDocument();
      expect(entry.querySelector('svg')).toHaveClass('lucide-wrench');
    },
  );

  it.each(['rules', 'browsers'] as const)(
    'remembers an initially open unpinned %s tool',
    async view => {
      window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '1');
      window.localStorage.setItem('mearl.popup.activeView', view);
      render(<Popup bootstrapConfig={bootstrapConfig} />);
      const content = view === 'rules' ? 'request rules content' : 'browser manager content';
      await screen.findByText(content);
      fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
      fireEvent.click(screen.getByRole('button', { name: 'popupToolToolbox' }));
      expect(await screen.findByText(content)).toBeInTheDocument();
      expect(screen.queryByText('toolbox content')).toBeNull();
    },
  );

  it('preserves the collapsed plugin when a pinned built-in is initially open', async () => {
    window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '4');
    window.localStorage.setItem('mearl.popup.activeView', 'browsers');
    window.localStorage.setItem(
      'mearl.popup.toolbox.activeTool',
      JSON.stringify({
        kind: 'plugin',
        id: 'plugin:notebook',
        title: 'Workspace Notes',
        icon: 'git-branch',
      }),
    );
    cacheToolboxNavigation([
      {
        id: 'plugin:notebook',
        plugin: 'notebook',
        title: 'Workspace Notes',
        icon: 'git-branch',
        order: 100,
      },
    ]);
    toolboxMocks.list.mockReturnValue(new Promise(() => {}));
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    await screen.findByText('browser manager content');
    const entry = screen.getByRole('button', { name: 'popupToolToolbox' });
    expect(entry).toHaveAttribute('title', 'Workspace Notes');
    fireEvent.click(entry);
    expect(await screen.findByText('toolbox content')).toBeInTheDocument();
    expect(entry).toHaveAttribute('title', 'Workspace Notes');
    expect(screen.getByText('toolbox content')).toHaveAttribute('data-initial-selection', 'stored');
  });

  it('opens an unpinned chat from the toolbox and returns to the tool list', async () => {
    window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '1');
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    fireEvent.click(screen.getByRole('button', { name: 'popupToolToolbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'open hidden chat' }));
    expect(await screen.findByText('agent chat content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'popupToolToolbox' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'toolboxBack' }));
    expect(screen.getByText('toolbox content')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'openAgentSidePanelFromPage' }),
    ).not.toBeInTheDocument();
  });

  it('remembers an unpinned plugin selected from the built-in tool switcher', async () => {
    window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '1');
    window.localStorage.setItem('mearl.popup.activeView', 'toolbox');
    toolboxMocks.list.mockResolvedValue({
      tools: [{ id: 'plugin:notebook', title: 'Workspace Notes', icon: 'git-branch' }],
    });
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    fireEvent.click(await screen.findByRole('button', { name: 'load-tools' }));
    await waitFor(() =>
      expect(window.localStorage.getItem('mearl.popup.toolbox.navigation')).toContain(
        'plugin:notebook',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'open hidden browsers' }));
    await screen.findByText('browser manager content');
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Workspace Notes' }));
    expect(await screen.findByText('toolbox content')).toHaveAttribute(
      'data-selected-tool',
      'plugin:notebook',
    );
    const entry = screen.getByRole('button', { name: 'popupToolToolbox' });
    expect(entry).toHaveAttribute('title', 'Workspace Notes');
    expect(entry.querySelector('svg')).toHaveClass('lucide-git-branch');
    fireEvent.click(screen.getByRole('button', { name: 'popupToolFormatter' }));
    fireEvent.click(entry);
    expect(await screen.findByText('toolbox content')).toBeInTheDocument();
    expect(screen.queryByText('browser manager content')).toBeNull();
    expect(entry).toHaveAttribute('title', 'Workspace Notes');
  });

  it('switches between unpinned built-ins and returns to the toolbox through its entry', async () => {
    window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '1');
    window.localStorage.setItem('mearl.popup.activeView', 'toolbox');
    render(<Popup bootstrapConfig={bootstrapConfig} />);
    fireEvent.click(await screen.findByRole('button', { name: 'open hidden browsers' }));
    await screen.findByText('browser manager content');
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'popupToolRules' }));
    await screen.findByText('request rules content');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'popupToolToolbox' }));
    expect(await screen.findByText('toolbox content')).toBeInTheDocument();
  });

  it('does not show standalone-page actions in browser management or request rules', () => {
    window.localStorage.setItem('mearl.popup.toolbox.pinnedCount', '4');
    render(<Popup bootstrapConfig={bootstrapConfig} />);

    fireEvent.click(screen.getByRole('button', { name: 'popupToolBrowsers' }));
    expect(screen.queryByTitle('openInNewTab')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'popupToolRules' }));
    expect(screen.queryByTitle('openInNewTab')).toBeNull();
  });
});
