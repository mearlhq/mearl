import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxToolPage } from '../SandboxToolPage';

const mocks = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(),
  clipboardImageWrite: vi.fn(),
  clipboardRead: vi.fn(),
  clipboardReadText: vi.fn(),
  loadBundle: vi.fn(),
  removeCache: vi.fn(),
  getCurrentLanguage: vi.fn(() => 'zh_CN'),
  requestNativeHost: vi.fn(),
  requestToolbox: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../../shared/toolboxPageBundle', () => ({
  loadToolboxPageBundle: mocks.loadBundle,
  removeCachedToolboxTool: mocks.removeCache,
}));
vi.mock('../../popup/toolboxRequest', () => ({ requestToolbox: mocks.requestToolbox }));
vi.mock('../../sidepanel/nativeHostRequest', () => ({
  requestNativeHost: mocks.requestNativeHost,
}));
vi.mock('../../sidepanel/SidepanelChat', () => ({
  SidepanelChat: ({
    agentGuides,
    agentTask,
    compact,
    initialCwd,
    onAgentTaskSettled,
    onClose,
    pageElementActions,
    toolboxConversationKey,
    toolboxContext,
    toolboxToolId,
  }: {
    agentGuides?: { title: string }[];
    agentTask?: { id: string; prompt: string; cwd?: string } | null;
    compact?: boolean;
    initialCwd?: string;
    onAgentTaskSettled?: (taskId: string, result: { ok: boolean; error?: string }) => void;
    onClose?: () => void;
    pageElementActions?: boolean;
    toolboxConversationKey?: string;
    toolboxContext?: string;
    toolboxToolId?: string;
  }) => (
    <div
      data-testid="agent-chat"
      data-agent-task={agentTask?.prompt}
      data-agent-cwd={agentTask?.cwd}
      data-agent-guide={agentGuides?.[0]?.title}
      data-compact={String(compact)}
      data-closable={Boolean(onClose)}
      data-initial-cwd={initialCwd}
      data-page-element-actions={pageElementActions}
      data-toolbox-conversation-key={toolboxConversationKey}
      data-toolbox-context={toolboxContext}
      data-toolbox-tool-id={toolboxToolId}
    >
      Agent chat
      <button type="button" onClick={onClose}>
        Close agent
      </button>
      <button
        type="button"
        onClick={() => agentTask && onAgentTaskSettled?.(agentTask.id, { ok: true })}
      >
        Submit task
      </button>
      <button
        type="button"
        onClick={() =>
          agentTask &&
          onAgentTaskSettled?.(agentTask.id, { ok: false, error: 'Codex rejected the task' })
        }
      >
        Reject task
      </button>
    </div>
  ),
}));
vi.mock('../../panel/utils/i18n', () => ({
  getCurrentLanguage: mocks.getCurrentLanguage,
  t: (key: string) => key,
}));
vi.mock('../../panel/utils/toast', () => ({ showToast: mocks.showToast }));
vi.mock('../toolboxClipboard', async importOriginal => ({
  ...(await importOriginal<typeof import('../toolboxClipboard')>()),
  writeToolboxClipboardImage: mocks.clipboardImageWrite,
}));

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
}

class FakeMessageChannel {
  static latest: FakeMessageChannel;
  port1 = new FakePort();
  port2 = new FakePort();

  constructor() {
    FakeMessageChannel.latest = this;
  }
}

describe('SandboxToolPage', () => {
  let darkMode = false;
  let themeChangeListener: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentLanguage.mockReturnValue('zh_CN');
    window.history.replaceState({}, '', '?notebook=abc#notebook');
    darkMode = false;
    themeChangeListener = null;
    vi.stubGlobal('MessageChannel', FakeMessageChannel);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return darkMode;
        },
        addEventListener: vi.fn((_type: string, listener: () => void) => {
          themeChangeListener = listener;
        }),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        getURL: vi.fn((path: string) =>
          path === 'plugin/sandbox.html'
            ? 'about:blank#mearl-plugin-sandbox'
            : `about:blank#${path}`,
        ),
      },
      tabs: { create: vi.fn().mockResolvedValue({ id: 42 }), query: vi.fn().mockResolvedValue([]) },
      windows: { getCurrent: vi.fn(async () => ({ id: 7 })) },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: mocks.clipboardWriteText,
        read: mocks.clipboardRead,
        readText: mocks.clipboardReadText,
      },
    });
    mocks.loadBundle.mockResolvedValue('<!doctype html><html><body>Notebook</body></html>');
    mocks.requestNativeHost.mockResolvedValue({ path: '/Users/name/project' });
    mocks.requestToolbox.mockResolvedValue({ result: { items: [] } });
    mocks.clipboardRead.mockResolvedValue([]);
    mocks.clipboardReadText.mockResolvedValue('<svg />');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses supplied HTML without reading the bundle again', async () => {
    render(
      <SandboxToolPage
        title="Cached tool"
        toolId="plugin:test"
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
        initialHtml="<!doctype html><html><body>Cached</body></html>"
      />,
    );
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    expect(mocks.loadBundle).not.toHaveBeenCalled();
  });

  it('shows host navigation actions before the fullscreen action', () => {
    render(
      <SandboxToolPage
        title="Tool"
        toolId="plugin:test"
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
        headerActions={<button>Switch tool</button>}
        onOpenInTab={() => {}}
      />,
    );
    const buttons = [...document.querySelectorAll('header button')];
    expect(buttons[0]).toHaveTextContent('Switch tool');
    expect(buttons[1]).toHaveAttribute('aria-label', 'openInNewTab');
  });

  it('owns user-script setup guidance for any tool and reloads its sandbox on retry', async () => {
    render(
      <SandboxToolPage
        title="Another tool"
        toolId="plugin:other"
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );
    const frame = await screen.findByTitle('Another tool');
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: (frame as HTMLIFrameElement).contentWindow,
          data: { type: 'mearl-plugin-ready' },
        }),
      ),
    );
    mocks.requestToolbox.mockRejectedValueOnce(
      new Error('USER_SCRIPTS_DISABLED: Enable Allow User Scripts'),
    );
    await act(async () =>
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'invoke', requestId: '1', command: 'state', input: {} },
      } as MessageEvent),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('toolboxUserScriptsHint');
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, handledByHost: true }),
    );
    fireEvent.click(screen.getByText('toolboxUserScriptsOpen'));
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome://extensions/?id=test-extension',
      active: true,
    });
    fireEvent.click(screen.getByText('retry'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTitle('Another tool')).not.toBe(frame);
  });

  it('starts the sandbox while HTML is pending and delivers HTML when it arrives', async () => {
    let resolve!: (value: string) => void;
    mocks.loadBundle.mockReturnValue(
      new Promise<string>(done => {
        resolve = done;
      }),
    );
    render(
      <SandboxToolPage
        title="Pending tool"
        toolId="plugin:test"
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );
    const frame = screen.getByTitle('Pending tool') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    expect(post).not.toHaveBeenCalled();
    await act(async () => resolve('<html>Ready</html>'));
    expect(screen.getByTitle('Pending tool')).toBe(frame);
    expect(post).toHaveBeenCalledWith(
      { type: 'mearl-plugin-load', html: expect.stringContaining('<html>Ready</html>') },
      '*',
    );
  });

  it('loads the registered bundle into a restricted iframe', async () => {
    render(
      <SandboxToolPage
        agent={{ enabled: true }}
        title="工作区笔记"
        toolId="plugin:notebook"
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );

    const frame = await screen.findByTitle('工作区笔记');
    expect(frame).toHaveAttribute('sandbox', 'allow-downloads allow-forms allow-scripts');
    expect(frame).toHaveAttribute('src', 'about:blank#mearl-plugin-sandbox');
    expect(chrome.runtime.getURL).toHaveBeenCalledWith('plugin/sandbox.html');
    expect(screen.getByRole('button', { name: 'agentChatTitle' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('checks for a Skill update and applies it after the user clicks the title bar button', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    let finishClear!: () => void;
    mocks.removeCache
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finishClear = resolve;
          }),
      );
    mocks.requestNativeHost.mockImplementation(async action => {
      if (action === 'agent_skills_check_updates') {
        return { updates: [{ name: 'notebook-skill', scope: 'global' }] };
      }
      if (action === 'agent_skills_update') return { ok: true, output: 'updated' };
      return { path: '/Users/name/project' };
    });
    render(
      <SandboxToolPage
        title="工作区笔记"
        toolId="plugin:notebook"
        skillUpdate={{ name: 'notebook-skill', scope: 'global' }}
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );

    const updateButton = await screen.findByRole('button', { name: 'toolboxSkillUpdate' });
    expect(mocks.requestNativeHost).toHaveBeenCalledWith('agent_skills_check_updates', {
      providerId: 'codex',
    });
    fireEvent.click(updateButton);
    await waitFor(() => {
      expect(mocks.requestNativeHost).toHaveBeenCalledWith('agent_skills_update', {
        providerId: 'codex',
        name: 'notebook-skill',
        scope: 'global',
      });
      expect(screen.getByRole('button', { name: 'toolboxSkillRefreshToApply' })).toBeEnabled();
    });
    expect(mocks.showToast).toHaveBeenCalledWith('toolboxSkillRefreshToApply', 'success');
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSkillRefreshToApply' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'toolboxSkillRefreshToApply' })).toBeEnabled(),
    );
    expect(mocks.showToast).toHaveBeenCalledWith('toolboxRefreshFailed', 'error');
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'toolboxSkillRefreshToApply' }));
    expect(mocks.removeCache).toHaveBeenCalledWith('plugin:notebook');
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'toolboxSkillRefreshToApply' })).toBeDisabled();
    await act(async () => {
      finishClear();
    });
    expect(reload).toHaveBeenCalledOnce();
    reload.mockRestore();
  });

  it('keeps the title bar unchanged when the installed Skill is current', async () => {
    mocks.requestNativeHost.mockImplementation(async action =>
      action === 'agent_skills_check_updates' ? { updates: [] } : { path: '/Users/name/project' },
    );
    render(
      <SandboxToolPage
        title="工作区笔记"
        toolId="plugin:notebook"
        skillUpdate={{ name: 'notebook-skill', scope: 'global' }}
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );

    await waitFor(() => {
      expect(mocks.requestNativeHost).toHaveBeenCalledWith('agent_skills_check_updates', {
        providerId: 'codex',
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'toolboxSkillUpdate' })).not.toBeInTheDocument();
  });

  it('keeps the update action available when updating fails', async () => {
    mocks.requestNativeHost.mockImplementation(async action => {
      if (action === 'agent_skills_check_updates') {
        return { updates: [{ name: 'notebook-skill', scope: 'global' }] };
      }
      if (action === 'agent_skills_update') throw new Error('network unavailable');
      return { path: '/Users/name/project' };
    });
    render(
      <SandboxToolPage
        title="工作区笔记"
        toolId="plugin:notebook"
        skillUpdate={{ name: 'notebook-skill', scope: 'global' }}
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'toolboxSkillUpdate' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'toolboxSkillUpdate' })).toBeEnabled();
    });
    expect(mocks.showToast).toHaveBeenCalledWith('toolboxSkillUpdateFailed', 'error');
  });

  it('uses embedded sizing and exposes popup navigation actions', async () => {
    const onBack = vi.fn();
    const onOpenInTab = vi.fn();
    const onQueryChange = vi.fn();
    const { container } = render(
      <SandboxToolPage
        embedded
        onBack={onBack}
        onOpenInTab={onOpenInTab}
        onQueryChange={onQueryChange}
        query={{ id: 'initial-id' }}
        title="工作区笔记"
        toolId="plugin:notebook"
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );

    const frame = (await screen.findByTitle('工作区笔记')) as HTMLIFrameElement;
    expect(container.firstElementChild).toHaveClass('h-full', 'w-full');
    expect(container.firstElementChild).not.toHaveClass('h-screen', 'w-screen');
    fireEvent.click(screen.getByRole('button', { name: 'toolboxBack' }));
    fireEvent.click(screen.getByRole('button', { name: 'openInNewTab' }));
    expect(onBack).toHaveBeenCalledExactlyOnceWith();
    expect(onOpenInTab).toHaveBeenCalledExactlyOnceWith();
    expect(screen.queryByRole('button', { name: 'agentChatTitle' })).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'mearl-plugin-ready' },
          source: frame.contentWindow,
        }),
      );
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'query-param',
          requestId: 'embedded-query',
          name: 'id',
          value: 'next-id',
        },
      } as MessageEvent);
    });
    expect(onQueryChange).toHaveBeenCalledWith({ id: 'next-id' });
    expect(window.location.search).toBe('?notebook=abc');
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'embedded-query',
      ok: true,
      result: { id: 'next-id' },
    });
  });

  it('injects a declared Preact runtime before handing the page to the sandbox', async () => {
    mocks.loadBundle.mockResolvedValue(
      '<!doctype html><html><head><script data-mearl-bridge>bridge()</script></head></html>',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => 'globalThis.preactReady = true;' }),
    );
    render(
      <SandboxToolPage
        title="工作区笔记"
        toolId="plugin:notebook"
        page={{
          type: 'sandbox',
          runtime: 'preact',
          hash: 'a'.repeat(64),
          size: 1,
          chunks: 1,
        }}
      />,
    );

    await act(async () => {});
    const frame = screen.getByTitle('工作区笔记') as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'mearl-plugin-host-ready' },
          source: frame.contentWindow,
        }),
      );
    });

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'mearl-plugin-load',
        html: expect.stringContaining(
          '<script data-mearl-runtime="preact">globalThis.preactReady = true;</script>',
        ),
      },
      '*',
    );
  });

  it('positions workspace Agent tools in their supplied content bounds', async () => {
    render(
      <SandboxToolPage
        agent={{ enabled: true, layout: 'workspace', pageElementActions: false }}
        title="工作区笔记"
        toolId="plugin:notebook"
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );

    const frame = (await screen.findByTitle('工作区笔记')) as HTMLIFrameElement;
    expect(screen.queryByRole('button', { name: 'agentChatTitle' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-chat')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'mearl-plugin-ready' },
          source: frame.contentWindow,
        }),
      );
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-guides',
          requestId: 'workspace-guides',
          guides: [
            {
              title: 'Check repositories',
              description: 'Review branches',
              prompt: 'Inspect repositories',
              icon: 'folder-git',
            },
          ],
        },
      } as MessageEvent);
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel',
          requestId: 'workspace-open',
          visible: true,
          bounds: { top: 8, left: 192, width: 700, height: 560 },
        },
      } as MessageEvent);
    });

    expect(screen.getByTestId('agent-chat')).toHaveAttribute('data-closable', 'false');
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-agent-guide',
      'Check repositories',
    );
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'workspace-guides',
      ok: true,
      result: null,
    });
    const workspaceChat = screen.getByTestId('agent-chat');
    expect(workspaceChat).toHaveAttribute('data-page-element-actions', 'false');
    const workspacePanel = workspaceChat.parentElement!;
    expect(workspacePanel).toHaveClass('visible');
    expect(workspacePanel).toHaveStyle({
      top: '8px',
      left: '192px',
      width: '700px',
      height: '560px',
    });
    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel-position',
          key: 'unrelated-anchor',
          bounds: { top: 0, left: 0, width: 20, height: 20 },
        },
      } as MessageEvent);
    });
    expect(workspacePanel.style.left).toBe('192px');
    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel-position',
          key: 'toolbox-workspace',
          bounds: { top: 0, left: 160, width: 480, height: 400 },
        },
      } as MessageEvent);
    });
    expect(workspacePanel).toHaveStyle({
      top: '0px',
      left: '160px',
      width: '480px',
      height: '400px',
    });
    expect(screen.getByTestId('agent-chat')).toBe(workspaceChat);
    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'page-modal', open: true },
      } as MessageEvent);
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'page-modal',
          open: false,
          positions: [
            { key: 'toolbox-workspace', bounds: { top: 4, left: 170, width: 480, height: 396 } },
          ],
        },
      } as MessageEvent);
    });
    expect(workspacePanel).toHaveStyle({
      top: '4px',
      left: '170px',
      width: '480px',
      height: '396px',
    });
    expect(screen.getByTestId('agent-chat')).toHaveAttribute('data-compact', 'false');
    expect(screen.getByTestId('agent-chat').parentElement).not.toHaveClass('border-l');
    expect(screen.getByTestId('agent-chat').parentElement).not.toHaveClass('max-w-[28rem]');

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel',
          requestId: 'drawer-open',
          visible: true,
          layout: 'drawer',
          key: 'notebook:overview',
          context: 'Notebook overview',
        },
      } as MessageEvent);
    });
    expect(screen.getByTestId('agent-chat')).toHaveAttribute('data-closable', 'true');
    expect(screen.getByTestId('agent-chat').parentElement).toHaveClass('max-w-[28rem]');
    expect(screen.getByTestId('agent-chat').parentElement).toHaveClass('border-l');
    expect(screen.getByTestId('agent-chat').parentElement).not.toHaveClass('left-72');
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-toolbox-conversation-key',
      'notebook:overview',
    );
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-toolbox-context',
      'Notebook overview',
    );
    expect(screen.getByTestId('agent-chat')).not.toHaveAttribute('data-initial-cwd');

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-guides',
          requestId: 'invalid-guides',
          guides: [{ title: 'Invalid', description: 'Missing prompt' }],
        },
      } as MessageEvent);
    });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'invalid-guides',
      ok: false,
      error: expect.stringContaining('Agent guide prompt'),
    });
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-agent-guide',
      'Check repositories',
    );

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'agent-panel', requestId: 'workspace-close', visible: false },
      } as MessageEvent);
    });
    expect(screen.getByTestId('agent-chat').parentElement).toHaveClass('translate-x-full');
  });

  it('uses the full workspace without an anchor and preserves keyed tasks while resizing', async () => {
    render(
      <SandboxToolPage
        agent={{ enabled: true, layout: 'workspace' }}
        title="Generic workspace"
        toolId="plugin:sample"
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );
    const frame = (await screen.findByTitle('Generic workspace')) as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'mearl-plugin-ready' },
          source: frame.contentWindow,
        }),
      );
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'agent-panel', requestId: 'workspace-full', visible: true },
      } as MessageEvent);
    });
    expect(screen.getByTestId('agent-chat').parentElement!.style.inset).toMatch(/^0(px)?$/);
    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-task',
          requestId: 'workspace-task',
          layout: 'workspace',
          key: 'sample:overview',
          prompt: 'Inspect this workspace',
          bounds: { top: 10, left: 100, width: 600, height: 400 },
        },
      } as MessageEvent);
    });
    const chat = screen.getByTestId('agent-chat');
    expect(chat).toHaveAttribute('data-agent-task', 'Inspect this workspace');
    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel-position',
          key: 'sample:overview',
          bounds: { top: 5, left: 120, width: 500, height: 300 },
        },
      } as MessageEvent);
    });
    expect(screen.getByTestId('agent-chat')).toBe(chat);
    expect(chat.parentElement).toHaveStyle({
      top: '5px',
      left: '120px',
      width: '500px',
      height: '300px',
    });
    expect(chat).toHaveAttribute('data-agent-task', 'Inspect this workspace');
    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel',
          requestId: 'close-unrelated',
          visible: false,
          key: 'sample:other',
        },
      } as MessageEvent);
    });
    expect(chat.parentElement).toHaveAttribute('aria-hidden', 'false');
    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel',
          requestId: 'close-workspace',
          visible: false,
          key: 'sample:overview',
        },
      } as MessageEvent);
    });
    expect(chat.parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(chat.parentElement).toHaveAttribute('inert');
  });

  it.each(['drawer', 'workspace'] as const)(
    'preserves the %s Agent task while a tool modal is open',
    async layout => {
      render(
        <SandboxToolPage
          agent={{ enabled: true, layout }}
          title="工作区笔记"
          toolId="plugin:notebook"
          page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
        />,
      );
      const frame = (await screen.findByTitle('工作区笔记')) as HTMLIFrameElement;
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'mearl-plugin-ready' },
            source: frame.contentWindow,
          }),
        );
        FakeMessageChannel.latest.port1.onmessage?.({
          data: { type: 'page-modal', open: true },
        } as MessageEvent);
        FakeMessageChannel.latest.port1.onmessage?.({
          data: {
            type: 'agent-task',
            requestId: 'task-during-modal',
            prompt: 'Continue release',
            layout,
          },
        } as MessageEvent);
      });
      const chat = screen.getByTestId('agent-chat');
      const panel = chat.parentElement!;
      expect(panel).toHaveStyle({ visibility: 'hidden' });
      expect(panel).toHaveAttribute('inert');
      expect(panel).toHaveAttribute('aria-hidden', 'true');
      expect(chat).toHaveAttribute('data-agent-task', 'Continue release');
      act(() => {
        FakeMessageChannel.latest.port1.onmessage?.({
          data: { type: 'page-modal', open: 'false' },
        } as MessageEvent);
      });
      expect(panel).toHaveStyle({ visibility: 'hidden' });
      act(() => {
        FakeMessageChannel.latest.port1.onmessage?.({
          data: { type: 'page-modal', open: false },
        } as MessageEvent);
      });
      expect(screen.getByTestId('agent-chat')).toBe(chat);
      expect(panel.style.visibility).toBe('');
      expect(panel).not.toHaveAttribute('inert');
      expect(panel).toHaveAttribute('aria-hidden', 'false');
      expect(chat).toHaveAttribute('data-agent-task', 'Continue release');
      act(() => {
        FakeMessageChannel.latest.port1.onmessage?.({
          data: { type: 'page-modal', open: true },
        } as MessageEvent);
        FakeMessageChannel.latest.port1.onmessage?.({
          data: { type: 'agent-panel', requestId: 'close-panel', visible: false },
        } as MessageEvent);
        FakeMessageChannel.latest.port1.onmessage?.({
          data: { type: 'page-modal', open: false },
        } as MessageEvent);
      });
      expect(panel).toHaveAttribute('aria-hidden', 'true');
      expect(panel).toHaveAttribute('inert');
    },
  );

  it('positions inline Agent chat inside the toolbox-provided card bounds', async () => {
    render(
      <SandboxToolPage
        agent={{ enabled: true, layout: 'workspace', pageElementActions: false }}
        title="工作区笔记"
        toolId="plugin:notebook"
        page={{ type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 }}
      />,
    );

    const frame = (await screen.findByTitle('工作区笔记')) as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'mearl-plugin-ready' },
          source: frame.contentWindow,
        }),
      );
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel',
          requestId: 'inline-open',
          visible: true,
          layout: 'inline',
          key: 'notebook:repository',
          cwd: '/Users/name/repository',
          bounds: { top: 120, left: 32, width: 640, height: 480 },
        },
      } as MessageEvent);
    });

    const panel = screen.getByTestId('agent-chat').parentElement!;
    expect(panel).not.toHaveClass('border-l', 'shadow-2xl');
    expect(panel).toHaveStyle({ top: '120px', left: '32px', width: '640px', height: '480px' });
    expect(screen.getByTestId('agent-chat')).toHaveAttribute('data-closable', 'false');
    expect(screen.getByTestId('agent-chat')).toHaveAttribute('data-page-element-actions', 'false');
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-toolbox-conversation-key',
      'notebook:repository',
    );
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-initial-cwd',
      '/Users/name/repository',
    );
    fireEvent.wheel(screen.getByTestId('agent-chat'), { deltaY: 120 });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'agent-panel-wheel',
      key: 'notebook:repository',
      deltaX: 0,
      deltaY: 120,
    });

    const scrollableChat = screen.getByTestId('agent-chat');
    scrollableChat.style.overflowY = 'auto';
    Object.defineProperties(scrollableChat, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    FakeMessageChannel.latest.port1.postMessage.mockClear();
    fireEvent.wheel(scrollableChat, { deltaY: 120 });
    expect(FakeMessageChannel.latest.port1.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent-panel-wheel' }),
    );

    fireEvent.wheel(scrollableChat, { deltaX: 80, deltaY: 12 });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'agent-panel-wheel',
      key: 'notebook:repository',
      deltaX: 80,
      deltaY: 0,
    });

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel-position',
          key: 'notebook:repository',
          bounds: { top: 48, left: 32, width: 640, height: 520 },
        },
      } as MessageEvent);
    });
    expect(panel).toHaveStyle({ top: '48px', height: '520px' });

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel',
          requestId: 'inline-switch',
          visible: true,
          layout: 'inline',
          key: 'notebook:another-repository',
          cwd: '/Users/name/another-repository',
          bounds: { top: 48, left: 704, width: 640, height: 520 },
        },
      } as MessageEvent);
    });
    const panels = screen.getAllByTestId('agent-chat');
    expect(panels).toHaveLength(2);
    expect(panels.map(current => current.getAttribute('data-toolbox-conversation-key'))).toEqual([
      'notebook:repository',
      'notebook:another-repository',
    ]);
    expect(panels[1]).toHaveAttribute('data-initial-cwd', '/Users/name/another-repository');

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'page-modal', open: true },
      } as MessageEvent);
    });
    for (const chat of panels) {
      expect(chat.parentElement).toHaveStyle({ visibility: 'hidden' });
      expect(chat.parentElement).toHaveAttribute('inert');
      expect(chat.parentElement).toHaveAttribute('aria-hidden', 'true');
    }
    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'page-modal',
          open: false,
          positions: [
            {
              key: 'notebook:repository',
              bounds: { top: 300, left: 24, width: 640, height: 480 },
            },
            {
              key: 'notebook:another-repository',
              bounds: { top: 312, left: 704, width: 640, height: 520 },
            },
            { key: 'unknown-panel', bounds: { top: 0, left: 0, width: 640, height: 480 } },
            { key: 'notebook:repository', bounds: { top: NaN, left: 0, width: 640, height: 480 } },
          ],
        },
      } as MessageEvent);
      // Restored panels have their new bounds before the message handler returns.
      expect(panels[0].parentElement).toHaveStyle({ top: '300px' });
      expect(panels[1].parentElement).toHaveStyle({ top: '312px' });
      expect(panels[0].parentElement!.style.visibility).toBe('');
      expect(panels[1].parentElement!.style.visibility).toBe('');
    });
    expect(screen.getAllByTestId('agent-chat')).toEqual(panels);
    for (const chat of panels) {
      expect(chat.parentElement!.style.visibility).toBe('');
      expect(chat.parentElement).not.toHaveAttribute('inert');
      expect(chat.parentElement).toHaveAttribute('aria-hidden', 'false');
    }

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-panel',
          requestId: 'inline-close-one',
          visible: false,
          key: 'notebook:repository',
        },
      } as MessageEvent);
    });
    expect(screen.getAllByTestId('agent-chat')).toHaveLength(1);
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-toolbox-conversation-key',
      'notebook:another-repository',
    );
  });

  it('bridges ready page calls to the native toolbox action', async () => {
    const page = { type: 'sandbox' as const, hash: 'a'.repeat(64), size: 1, chunks: 1 };
    const { rerender } = render(
      <SandboxToolPage
        agent={{ enabled: true }}
        title="工作区笔记"
        toolId="plugin:notebook"
        page={page}
      />,
    );
    // The sandbox sends its ready message after the HTML and its listener are committed.
    await act(async () => {});
    const frame = screen.getByTitle('工作区笔记') as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'mearl-plugin-host-ready' },
          source: frame.contentWindow,
        }),
      );
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'mearl-plugin-load',
        html: '<!doctype html><html><body>Notebook</body></html>',
      },
      '*',
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'mearl-plugin-ready' },
          source: frame.contentWindow,
        }),
      );
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mearl-plugin-connect',
        context: expect.objectContaining({
          locale: 'zh_CN',
          theme: 'light',
          title: '工作区笔记',
          query: { notebook: 'abc' },
        }),
      }),
      '*',
      [FakeMessageChannel.latest.port2],
    );

    act(() => {
      darkMode = true;
      themeChangeListener?.();
    });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'context',
      context: { theme: 'dark', locale: 'zh_CN', title: '工作区笔记' },
    });

    const channel = FakeMessageChannel.latest;
    mocks.getCurrentLanguage.mockReturnValue('en');
    rerender(
      <SandboxToolPage
        agent={{ enabled: true }}
        title="Workspace Notes"
        toolId="plugin:notebook"
        page={page}
      />,
    );
    expect(channel.port1.postMessage).toHaveBeenCalledWith({
      type: 'context',
      context: { theme: 'dark', locale: 'en', title: 'Workspace Notes' },
    });
    expect(channel.port1.close).not.toHaveBeenCalled();
    expect(FakeMessageChannel.latest).toBe(channel);

    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: '1',
          command: 'list',
          input: {},
        },
      } as MessageEvent);
    });

    await waitFor(() =>
      expect(mocks.requestToolbox).toHaveBeenCalledWith('toolbox_tool_invoke', {
        id: 'plugin:notebook',
        command: 'list',
        input: {},
      }),
    );
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: '1',
      ok: true,
      result: { items: [] },
    });

    mocks.requestToolbox.mockResolvedValueOnce({
      taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
      state: 'running',
    });
    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: 'start-1',
          command: 'host.task.start',
          input: {
            command: 'publish-all',
            input: { notebookId: 'notebook-1', environment: 'daily' },
          },
        },
      } as MessageEvent);
    });
    await waitFor(() =>
      expect(mocks.requestToolbox).toHaveBeenCalledWith('toolbox_task', {
        operation: 'start',
        id: 'plugin:notebook',
        command: 'publish-all',
        input: { notebookId: 'notebook-1', environment: 'daily' },
      }),
    );
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'start-1',
      ok: true,
      result: {
        taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
        state: 'running',
      },
    });

    mocks.requestToolbox.mockResolvedValueOnce({
      taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
      state: 'success',
      result: { published: true },
    });
    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: 'operation-1',
          command: 'host.task.get',
          input: {
            taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
          },
        },
      } as MessageEvent);
    });
    await waitFor(() =>
      expect(mocks.requestToolbox).toHaveBeenCalledWith('toolbox_task', {
        operation: 'get',
        id: 'plugin:notebook',
        taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
      }),
    );
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'operation-1',
      ok: true,
      result: {
        taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
        state: 'success',
        result: { published: true },
      },
    });

    mocks.requestToolbox.mockResolvedValueOnce({
      operations: [
        {
          taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
          command: 'publish-all',
          input: { notebookId: 'notebook-1', environment: 'daily' },
          state: 'running',
          updatedAt: 1,
        },
      ],
    });
    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: 'operations-1',
          command: 'host.task.list',
          input: {},
        },
      } as MessageEvent);
    });
    await waitFor(() =>
      expect(mocks.requestToolbox).toHaveBeenCalledWith('toolbox_task', {
        operation: 'list',
        id: 'plugin:notebook',
      }),
    );
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'operations-1',
      ok: true,
      result: {
        operations: [
          expect.objectContaining({
            taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
            command: 'publish-all',
          }),
        ],
      },
    });

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: 'toast-1',
          command: 'host.toast',
          input: { message: '保存成功', type: 'success', duration: 2500 },
        },
      } as MessageEvent);
    });
    expect(mocks.showToast).toHaveBeenCalledWith('保存成功', 'success', 2500);

    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: 'clipboard-1',
          command: 'host.clipboard.writeText',
          input: { text: '**wenwen **`daily/1.10.1`' },
        },
      } as MessageEvent);
    });
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('**wenwen **`daily/1.10.1`');
    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: 'image-copy-1',
          command: 'host.clipboard.writeImage',
          input: { data: 'data:image/png;base64,cG5n' },
        },
      } as MessageEvent);
    });
    expect(mocks.clipboardImageWrite).toHaveBeenCalledWith('data:image/png;base64,cG5n');
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'image-copy-1',
      ok: true,
      result: null,
    });
    mocks.clipboardImageWrite.mockRejectedValueOnce(new Error('permission denied'));
    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: 'image-copy-2',
          command: 'host.clipboard.writeImage',
          input: { data: 'data:image/png;base64,cG5n' },
        },
      } as MessageEvent);
    });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'image-copy-2',
      ok: false,
      error: 'permission denied',
    });
    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'invoke', requestId: 'read-1', command: 'host.clipboard.read', input: {} },
      } as MessageEvent);
    });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'read-1',
      ok: true,
      result: { type: 'text', data: '<svg />' },
    });
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
      { id: 42, title: 'Current page', url: 'https://example.test/' },
    ] as chrome.tabs.Tab[]);
    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'invoke', requestId: 'tab-1', command: 'host.tab.active', input: {} },
      } as MessageEvent);
    });
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'tab-1',
      ok: true,
      result: { tabId: 42, title: 'Current page', url: 'https://example.test/' },
    });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'clipboard-1',
      ok: true,
      result: null,
    });

    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: 'external-link-1',
          command: 'host.link.open',
          input: { url: 'https://projects.example.test/notebook/123/basic' },
        },
      } as MessageEvent);
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://projects.example.test/notebook/123/basic',
      active: true,
    });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'external-link-1',
      ok: true,
      result: null,
    });

    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'invoke',
          requestId: 'external-link-2',
          command: 'host.link.open',
          input: { url: 'javascript:alert(1)' },
        },
      } as MessageEvent);
    });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'external-link-2',
      ok: false,
      error: 'External link must use HTTP or HTTPS without embedded credentials',
    });

    await act(async () => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'invoke', requestId: '2', command: 'host.directory.select', input: {} },
      } as MessageEvent);
    });
    await waitFor(() =>
      expect(mocks.requestNativeHost).toHaveBeenCalledWith('agent_chat_pick_directory'),
    );
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: '2',
      ok: true,
      result: '/Users/name/project',
    });

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'agent-panel', requestId: '3', visible: true },
      } as MessageEvent);
    });
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-toolbox-tool-id',
      'plugin:notebook',
    );
    expect(screen.getByTestId('agent-chat').parentElement).not.toHaveClass('translate-x-full');

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-task',
          requestId: 'agent-task-1',
          prompt: 'Resolve the package.json conflict',
          cwd: '/Users/name/project',
          ephemeral: false,
        },
      } as MessageEvent);
    });
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-agent-task',
      'Resolve the package.json conflict',
    );
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-agent-cwd',
      '/Users/name/project',
    );
    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-task',
          requestId: 'agent-task-temporary',
          prompt: 'Temporary request',
          ephemeral: true,
        },
      } as MessageEvent);
    });
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'agent-task-temporary',
      ok: false,
      error: 'agentChatTemporaryUnsupported',
    });
    expect(screen.getByTestId('agent-chat').parentElement).not.toHaveClass('translate-x-full');
    expect(FakeMessageChannel.latest.port1.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'agent-task-1' }),
    );

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'agent-task',
          requestId: 'agent-task-2',
          prompt: 'Continue the release',
          cwd: '/Users/name/project',
        },
      } as MessageEvent);
    });
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-agent-task',
      'Resolve the package.json conflict',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit task' }));
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'agent-task-1',
      ok: true,
      result: null,
    });
    expect(screen.getByTestId('agent-chat')).toHaveAttribute(
      'data-agent-task',
      'Continue the release',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject task' }));
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'agent-task-2',
      ok: false,
      error: 'Codex rejected the task',
    });

    fireEvent.click(screen.getByRole('button', { name: 'agentChatTitle' }));
    expect(screen.getByTestId('agent-chat').parentElement).toHaveClass('translate-x-full');
    fireEvent.click(screen.getByRole('button', { name: 'agentChatTitle' }));
    expect(screen.getByTestId('agent-chat').parentElement).not.toHaveClass('translate-x-full');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('agent-chat').parentElement).toHaveClass('translate-x-full');
    fireEvent.click(screen.getByRole('button', { name: 'agentChatTitle' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close agent' }));
    expect(screen.getByTestId('agent-chat').parentElement).toHaveClass('translate-x-full');

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: { type: 'agent-panel', requestId: '4', visible: false },
      } as MessageEvent);
    });
    expect(screen.getByTestId('agent-chat').parentElement).toHaveClass('translate-x-full');
    await waitFor(() =>
      expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
        type: 'result',
        requestId: '4',
        ok: true,
        result: null,
      }),
    );

    act(() => {
      FakeMessageChannel.latest.port1.onmessage?.({
        data: {
          type: 'query-param',
          requestId: '5',
          name: 'notebook',
          value: 'notebook-id',
        },
      } as MessageEvent);
    });
    expect(window.location.search).toBe('?notebook=notebook-id');
    expect(window.location.hash).toBe('#notebook');
    expect(FakeMessageChannel.latest.port1.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: '5',
      ok: true,
      result: { notebook: 'notebook-id' },
    });
  });
});
