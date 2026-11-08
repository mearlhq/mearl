import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceOfficialPluginCatalog } from '../../officialPluginCatalog.js';
import {
  findOfficialPlugin,
  findPluginEntry,
  findPluginRegistration,
  invokeRegisteredPlugin,
  invokeRegisteredToolboxPlugin,
  listOfficialPluginNames,
  listPluginNames,
  loadPlugin,
  PluginError,
  readPluginPageBundleChunk,
  registerPlugin,
  unregisterPlugin,
} from '../plugin.js';
import { runMearlCli } from '../../../cli.js';
import { COMMAND_MAP } from '../../../commands.js';
import { setSkillEnabled } from '../../skillManifest.js';
import { UnifiedClient } from '../../../unified.js';

let directory: string;
let entry: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-plugin-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  replaceOfficialPluginCatalog('a'.repeat(64), {
    identity: { description: 'Identity fixture', installArgs: ['https://example.com/skills', '--skill', 'identity-request', '--yes'], skill: 'identity-request' },
    headers: { description: 'Headers fixture', installArgs: ['https://example.com/skills', '--skill', 'headers-request', '--yes'], skill: 'headers-request' },
    accounts: { description: 'Account fixture', installArgs: ['https://example.com/skills', '--skill', 'accounts', '--yes'], skill: 'accounts', setup: 'team' },
  });
  entry = join(directory, 'scripts', 'main.mjs');
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(join(directory, 'assets', 'toolbox'), { recursive: true });
  writeFileSync(
    join(directory, 'assets', 'toolbox', 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><main>Tool</main><script src="./app.js"></script></body></html>',
  );
  writeFileSync(join(directory, 'assets', 'toolbox', 'style.css'), 'main { color: #123456; }');
  writeFileSync(join(directory, 'assets', 'toolbox', 'app.js'), 'window.toolLoaded = true;');
  writeFileSync(
    join(directory, 'SKILL.md'),
    '---\nname: sample\ndescription: skill trigger details\nversion: "1.2.3"\n---\n',
  );
  writeFileSync(
    entry,
    `export const description = 'Short plugin summary';
  export default app => {
    app.command('read <url>', input => app.invoke('send_request', input), '读取', ['read https://example.com']);
    app.command('echo [value]', input => input);
    app.command('files <paths...>', input => input);
    app.command('progress [message]', ({ message = 'working' }) => { app.progress(message); return { message }; });
    app.command('structured-progress', () => { app.progress({ message: 'publishing', data: { phase: 'publishing', repositoryId: 'sample' } }); });
    app.command('dependency [value]', input => app.invoke('child', { command: 'echo', input }));
    app.command('write', input => ({ written: true, input }));
    app.command('unsuccessful', () => ({ success: false, reason: 'rejected' }));
    app.command('fail', () => { throw new Error('business failed'); });
  };`,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('plugin registration', () => {
  it('runs an action-named plugin through its declared default command and keeps builtin names reserved', async () => {
    writeFileSync(entry, `export const name = 'sample_request';
      export const defaultCommand = 'read';
      export default app => app.command('read <url>', input => app.invoke('send_request', input), 'Read');`);
    registerPlugin('sample_request', entry);
    expect(listPluginNames()).toContain('sample_request');
    expect(findPluginEntry('sample_request')).toBe(entry);
    const invoke = vi.fn(async (_action, input) => input);
    const plugin = await loadPlugin(entry, { options: {}, invoke, progress: () => {} });
    expect(await plugin.run([], { url: 'https://example.test/', method: 'POST' })).toEqual({ url: 'https://example.test/', method: 'POST' });
    expect(await plugin.run(['https://example.test/'], undefined, { method: 'GET' })).toEqual({ url: 'https://example.test/', method: 'GET' });
    expect(await plugin.run([], { command: 'read', input: { url: 'https://example.test/' } })).toEqual({ url: 'https://example.test/' });
    expect(plugin.help('mearl sample_request')).toContain('mearl sample_request <url>');
    expect(plugin.commandHelp('mearl sample_request')).not.toContain('sample_request read');
    expect(() => registerPlugin('page_click', entry)).toThrow('PLUGIN_INVALID_NAME');
    for (const name of ['plugin_state', 'plugin_model', 'plugin_page', 'plugin_invoke_child', 'plugin_task_checkpoint']) {
      expect(() => registerPlugin(name, entry)).toThrow('PLUGIN_INVALID_NAME');
    }
    unregisterPlugin('sample_request');
    expect(findPluginEntry('sample_request')).toBeUndefined();
  });
  it.each(['missing', 'private'])('rejects an unavailable default command: %s', async name => {
    writeFileSync(entry, `export const defaultCommand = '${name}'; export const toolbox = { version: 1, title: 'Tool', page: { type: 'sandbox', entry: 'assets/toolbox/index.html', commands: ['private'] } }; export default app => { app.command('read', () => null); app.toolboxCommand('private', () => null); };`);
    await expect(loadPlugin(entry, { options: {}, invoke: vi.fn(), progress: () => {} })).rejects.toThrow('defaultCommand');
  });
  it('installs only whitelisted plugins on first call and initializes Accounts at setup', () => {
    expect(listOfficialPluginNames('team')).toEqual(['accounts']);
    expect(listOfficialPluginNames()).toEqual(['identity', 'headers', 'accounts']);
    expect(listOfficialPluginNames().every(name => !COMMAND_MAP.has(name))).toBe(true);
    expect(findOfficialPlugin('sample-docs')).toBeUndefined();
    expect(findOfficialPlugin('unknown')).toBeUndefined();
  });

  it('accepts relative directories and absolute files, and replaces a name atomically', () => {
    expect(registerPlugin('sample', relative(process.cwd(), directory))).toBe(entry);
    expect(findPluginEntry('sample')).toBe(entry);
    const custom = join(directory, 'other.mjs');
    writeFileSync(custom, 'export default () => {};');
    registerPlugin('sample', custom);
    registerPlugin('another', entry);
    expect(findPluginEntry('sample')).toBe(custom);
    expect(listPluginNames()).toEqual(['another', 'sample']);
    expect(JSON.parse(readFileSync(join(directory, 'registry/sample.json'), 'utf8'))).toEqual({
      entry: custom,
      source: { entry: expect.any(String) },
    });
  });

  it('resolves a Python-only skill directory and keeps JavaScript as the compatible default', () => {
    const pythonSkill = join(directory, 'python-only');
    const pythonEntry = join(pythonSkill, 'scripts', 'main.py');
    mkdirSync(dirname(pythonEntry), { recursive: true });
    writeFileSync(pythonEntry, 'def register(app):\n    pass\n');
    expect(registerPlugin('python-sample', pythonSkill)).toBe(pythonEntry);

    writeFileSync(join(pythonSkill, 'scripts', 'main.mjs'), 'export default () => {};');
    expect(registerPlugin('preferred-entry', pythonSkill)).toBe(
      join(pythonSkill, 'scripts', 'main.mjs'),
    );
  });

  it('stores an optional trimmed description with the registration', () => {
    registerPlugin('sample', entry, '  Short plugin summary  ');
    expect(findPluginRegistration('sample')).toEqual({
      entry,
      description: 'Short plugin summary',
      source: { entry: expect.any(String) },
    });
  });

  it('stores the manager that owns an automatically maintained registration', () => {
    registerPlugin('sample', entry, undefined, { managedBy: '  @mearl/setup  ' });
    expect(findPluginRegistration('sample')).toEqual({
      entry,
      managedBy: '@mearl/setup',
      source: { entry: expect.any(String) },
    });
  });

  it('stores a validated toolbox contribution with the plugin registration', () => {
    const toolbox = {
      version: 1 as const,
      title: 'Workspace Notes',
      description: 'Organize workspace notes',
      icon: 'git-branch',
      agent: {
        skill: 'notebook-skill',
        layout: 'workspace' as const,
        pageElementActions: false,
      },
      page: {
        type: 'sandbox' as const,
        runtime: 'preact' as const,
        entry: 'assets/toolbox/index.html',
        commands: ['echo', 'write'],
      },
      order: 120,
    };
    registerPlugin('sample', entry, undefined, { toolbox });
    for (const lifecycle of [null, {}, [], { onNavigation: 'missing' }, { onNavigation: 1 }]) {
      expect(() =>
        registerPlugin('sample', entry, undefined, {
          toolbox: { ...toolbox, page: { ...toolbox.page, lifecycle: lifecycle as never } },
        }),
      ).toThrow('toolbox.page.lifecycle');
    }
    for (const displayMode of ['popup', 'tab', 'both'] as const) {
      registerPlugin('sample', entry, undefined, { toolbox: { ...toolbox, displayMode } });
      expect(findPluginRegistration('sample')?.toolbox?.displayMode).toBe(displayMode);
    }
    expect(() =>
      registerPlugin('sample', entry, undefined, {
        toolbox: { ...toolbox, displayMode: 'window' as never },
      }),
    ).toThrow('toolbox.displayMode');
    expect(() =>
      registerPlugin('sample', entry, undefined, {
        toolbox: { ...toolbox, agent: { ...toolbox.agent, pageElementActions: 'false' as never } },
      }),
    ).toThrow('toolbox.agent.pageElementActions');
    registerPlugin('sample', entry, undefined, { toolbox });
    expect(findPluginRegistration('sample')).toMatchObject({
      entry,
      toolbox,
      pageBundle: {
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        size: expect.any(Number),
        chunks: 1,
      },
    });
    expect(() =>
      registerPlugin('sample', entry, undefined, {
        toolbox: { ...toolbox, page: { ...toolbox.page, entry: '../outside.html' } },
      }),
    ).toThrow('PLUGIN_INVALID_TOOLBOX');
    expect(() =>
      registerPlugin('sample', entry, undefined, {
        toolbox: { ...toolbox, page: { ...toolbox.page, commands: ['echo', 'echo'] } },
      }),
    ).toThrow('PLUGIN_INVALID_TOOLBOX');
    expect(() =>
      registerPlugin('sample', entry, undefined, {
        toolbox: {
          ...toolbox,
          page: { ...toolbox.page, runtime: 'vue' as never },
        },
      }),
    ).toThrow('PLUGIN_INVALID_TOOLBOX');
    expect(() =>
      registerPlugin('sample', entry, undefined, {
        toolbox: {
          ...toolbox,
          agent: {
            ...toolbox.agent,
            skill: 'invalid skill',
          },
        },
      }),
    ).toThrow('PLUGIN_INVALID_TOOLBOX');
    expect(() =>
      registerPlugin('sample', entry, undefined, {
        toolbox: {
          ...toolbox,
          agent: {
            ...toolbox.agent,
            layout: 'floating' as never,
          },
        },
      }),
    ).toThrow('PLUGIN_INVALID_TOOLBOX');
  });

  it('packages local page resources at registration without a skill build step', async () => {
    const toolbox = {
      version: 1 as const,
      title: 'Workspace Notes',
      page: {
        type: 'sandbox' as const,
        entry: 'assets/toolbox/index.html',
        commands: ['echo'],
      },
    };
    registerPlugin('sample', entry, undefined, { toolbox });
    const bundle = findPluginRegistration('sample')!.pageBundle!;
    const chunk = readPluginPageBundleChunk('sample', bundle.hash, 0);
    const html = Buffer.from(chunk.data, 'base64').toString('utf8');

    expect(chunk).toMatchObject({ hash: bundle.hash, index: 0, total: 1 });
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('data-mearl-theme');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('--mearl-bg-primary');
    expect(html).toContain('--mearl-action-primary');
    expect(html).toContain('mearl-plugin-ready');
    expect(html).toContain('data-mearl-bridge');
    expect(html).toContain('const invoke =');
    expect(html).toContain('const subscribe =');
    expect(html).not.toContain('const copyText =');
    expect(html).not.toContain('openCodex');
    expect(html).not.toContain('openPath');
    expect(html).not.toContain('openVsCode');
    expect(html).toContain('runAgentTask');
    expect(html).not.toContain('const selectDirectory =');
    expect(html).toContain('setAgentGuides');
    expect(html).toContain('setAgentPanelVisible');
    expect(html).toContain('setQueryParam');
    expect(html).not.toContain('const toast =');
    expect(html).toContain('window.toolLoaded = true;');
    expect(html).toContain('main { color: #123456; }');
    expect(html).not.toContain('src="./app.js"');
    expect(html).not.toContain('href="./style.css"');

    const bridgeScript = html.match(/<script data-mearl-bridge>([\s\S]*?)<\/script>/)?.[1];
    expect(bridgeScript).toBeDefined();
    let connectListener:
      | ((event: { data: unknown; ports: unknown[]; source: unknown }) => void)
      | undefined;
    let clickListener:
      | ((event: {
          button: number;
          defaultPrevented: boolean;
          preventDefault(): void;
          target: unknown;
        }) => void)
      | undefined;
    const parent = { postMessage: vi.fn() };
    interface FakeScroller {
      clientHeight: number;
      clientWidth: number;
      parentElement: FakeScroller | null;
      scrollHeight: number;
      scrollLeft: number;
      scrollTop: number;
      scrollWidth: number;
    }
    const pageScroller: FakeScroller = {
      clientHeight: 600,
      clientWidth: 800,
      parentElement: null,
      scrollHeight: 1200,
      scrollLeft: 0,
      scrollTop: 100,
      scrollWidth: 800,
    };
    const nestedScroller: FakeScroller = {
      clientHeight: 480,
      clientWidth: 640,
      parentElement: pageScroller,
      scrollHeight: 960,
      scrollLeft: 0,
      scrollTop: 480,
      scrollWidth: 640,
    };
    const fakeWindow = {
      parent,
      addEventListener: vi.fn(
        (
          _type: string,
          listener: (event: { data: unknown; ports: unknown[]; source: unknown }) => void,
        ) => {
          connectListener = listener;
        },
      ),
      getComputedStyle: vi.fn((element: unknown) => ({
        overflowX: 'visible',
        overflowY: element === pageScroller || element === nestedScroller ? 'auto' : 'visible',
      })),
      removeEventListener: vi.fn(),
      scrollBy: vi.fn(),
    };
    const documentElement = { dataset: {} as Record<string, string>, style: {} };
    let modalDialogCount = 0;
    const fakeDocument = {
      documentElement,
      querySelector: vi.fn(() => (modalDialogCount > 0 ? {} : null)),
      addEventListener: vi.fn((type: string, listener: typeof clickListener) => {
        if (type === 'click') clickListener = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const port = {
      onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
      postMessage: vi.fn(),
      start: vi.fn(),
    };
    class FakeElement {
      rect = { top: 120, left: 24, width: 640, height: 480 };
      isConnected = true;
      parentElement: FakeScroller | null = nestedScroller;
      clientHeight = 480;
      clientWidth = 640;
      scrollHeight = 480;
      scrollLeft = 0;
      scrollTop = 0;
      scrollWidth = 640;
      getBoundingClientRect() {
        return this.rect;
      }
    }
    const observerCallbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(callback: () => void) {
        observerCallbacks.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    const ui = Object.freeze({ runtime: 'preact', version: '10.29.0' });
    const animationFrames = new Map<number, () => void>();
    let frameSequence = 0;
    const flushAnimationFrames = () => {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      for (const callback of callbacks) callback();
    };
    const bridgeContext = {
      setTimeout,
      clearTimeout,
      crypto: webcrypto,
      TextDecoder,
      atob,
      __mearlToolboxUi: ui,
      cancelAnimationFrame: vi.fn((id: number) => animationFrames.delete(id)),
      document: fakeDocument,
      Element: FakeElement,
      MutationObserver: FakeObserver,
      requestAnimationFrame: vi.fn((callback: () => void) => {
        const id = ++frameSequence;
        animationFrames.set(id, callback);
        return id;
      }),
      ResizeObserver: FakeObserver,
      URL,
      window: fakeWindow,
    };
    runInNewContext(bridgeScript!, bridgeContext);
    connectListener?.({
      data: { type: 'mearl-plugin-connect', context: { theme: 'dark' } },
      ports: [port],
      source: parent,
    });
    expect(documentElement.dataset.mearlTheme).toBe('dark');
    port.onmessage?.({ data: { type: 'context', context: { query: { notebook: 'next' } } } });
    expect(documentElement.dataset.mearlTheme).toBe('dark');
    const mearl = (
      fakeWindow as typeof fakeWindow & {
        mearl: {
          ui: typeof ui;
          context: Record<string, unknown>;
          ready(): Promise<Record<string, unknown>>;
          onContextChange(listener: (context: Record<string, unknown>) => void): () => void;
          invoke(command: string, input?: Record<string, unknown>): Promise<any>;
          readTaskResult(taskId: string): Promise<unknown>;
          subscribe(
            source: string,
            target: Record<string, unknown>,
            listener: (event: unknown) => void,
          ): Promise<() => void>;
          runAgentTask(
            prompt: string,
            options?: {
              cwd?: string;
              ephemeral?: boolean;
              layout?: 'drawer' | 'workspace' | 'inline';
              anchor?: FakeElement;
              key?: string;
            },
          ): Promise<void>;
          setAgentPanelVisible(
            visible: boolean,
            options?: {
              layout?: 'drawer' | 'workspace' | 'inline';
              anchor?: FakeElement;
              context?: string;
              key?: string;
              cwd?: string;
            },
          ): Promise<void>;
          setAgentGuides(
            guides: Array<{
              title: string;
              description: string;
              prompt: string;
              icon?: string;
            }>,
          ): Promise<void>;
        };
      }
    ).mearl;
    expect(mearl.ui).toBe(ui);
    const contextChanged = vi.fn();
    const unsubscribeContext = mearl.onContextChange(contextChanged);
    expect(contextChanged).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
    port.onmessage?.({ data: { type: 'context', context: { locale: 'en', title: 'Tools' } } });
    expect(contextChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        locale: 'en',
        theme: 'dark',
        title: 'Tools',
        query: { notebook: 'next' },
      }),
    );
    expect(await mearl.ready()).toBe(mearl.context);
    expect(Object.isFrozen(mearl.context)).toBe(true);
    unsubscribeContext();
    port.onmessage?.({ data: { type: 'context', context: { locale: 'zh_CN' } } });
    expect(contextChanged).toHaveBeenCalledTimes(2);
    expect(bridgeContext).not.toHaveProperty('__mearlToolboxUi');
    const agentTask = mearl.runAgentTask('Resolve the merge conflict', {
      cwd: '/Users/name/project',
      layout: 'drawer',
    });
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'agent-task',
      requestId: '1',
      prompt: 'Resolve the merge conflict',
      cwd: '/Users/name/project',
      layout: 'drawer',
    });
    port.onmessage?.({ data: { type: 'result', requestId: '1', ok: true, result: null } });
    await expect(agentTask).resolves.toBeUndefined();
    await expect(mearl.runAgentTask('Temporary request', { ephemeral: true })).rejects.toThrow(
      'Temporary Agent conversations are not supported',
    );
    const clipboardWrite = mearl.invoke('host.clipboard.writeText', {
      text: '**wenwen **`daily/1.10.1`',
    });
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'invoke',
      requestId: '2',
      command: 'host.clipboard.writeText',
      input: { text: '**wenwen **`daily/1.10.1`' },
    });
    port.onmessage?.({ data: { type: 'result', requestId: '2', ok: true, result: null } });
    await expect(clipboardWrite).resolves.toBeNull();
    const start = mearl.invoke('host.task.start', {
      command: 'publish-all',
      input: {
        notebookId: 'notebook-1',
        environment: 'daily',
      },
    });
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'invoke',
      requestId: '3',
      command: 'host.task.start',
      input: {
        command: 'publish-all',
        input: { notebookId: 'notebook-1', environment: 'daily' },
      },
    });
    port.onmessage?.({
      data: {
        type: 'result',
        requestId: '3',
        ok: true,
        result: {
          taskId: '11111111-1111-4111-8111-111111111111',
          state: 'running',
        },
      },
    });
    await expect(start).resolves.toMatchObject({ state: 'running' });
    const operation = mearl.invoke('host.task.get', {
      taskId: '11111111-1111-4111-8111-111111111111',
    });
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'invoke',
      requestId: '4',
      command: 'host.task.get',
      input: { taskId: '11111111-1111-4111-8111-111111111111' },
    });
    port.onmessage?.({
      data: {
        type: 'result',
        requestId: '4',
        ok: true,
        result: { state: 'success', result: { published: true } },
      },
    });
    await expect(operation).resolves.toMatchObject({ state: 'success' });
    const runningOperations = mearl.invoke('host.task.list');
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'invoke',
      requestId: '5',
      command: 'host.task.list',
      input: {},
    });
    port.onmessage?.({
      data: {
        type: 'result',
        requestId: '5',
        ok: true,
        result: {
          operations: [
            {
              taskId: '22222222-2222-4222-8222-222222222222',
              command: 'repository-publish',
              input: { notebookId: 'notebook-1', repositoryId: 'repository-1' },
              state: 'running',
              updatedAt: 1,
            },
          ],
        },
      },
    });
    await expect(runningOperations).resolves.toMatchObject({
      operations: [{ command: 'repository-publish', state: 'running' }],
    });
    const setAgentGuides = mearl.setAgentGuides([
      {
        title: ' Check repositories ',
        description: ' Review branches and local changes ',
        prompt: ' Inspect the selected notebook ',
        icon: 'folder-git',
      },
    ]);
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'agent-guides',
      requestId: '6',
      guides: [
        {
          title: 'Check repositories',
          description: 'Review branches and local changes',
          prompt: 'Inspect the selected notebook',
          icon: 'folder-git',
        },
      ],
    });
    port.onmessage?.({ data: { type: 'result', requestId: '6', ok: true, result: null } });
    await expect(setAgentGuides).resolves.toBeUndefined();
    await expect(
      mearl.setAgentGuides([
        { title: 'Invalid guide', description: 'Missing a prompt', prompt: '' },
      ]),
    ).rejects.toThrow('Agent guide prompt');

    const preventDefault = vi.fn();
    clickListener?.({
      button: 0,
      defaultPrevented: false,
      preventDefault,
      target: {
        closest: () => ({
          href: 'https://work.example.com/projects/sample/overview',
          target: '_blank',
          hasAttribute: () => false,
        }),
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'invoke',
      requestId: '7',
      command: 'host.link.open',
      input: { url: 'https://work.example.com/projects/sample/overview' },
    });
    port.onmessage?.({ data: { type: 'result', requestId: '7', ok: true, result: null } });

    const inlineAnchor = new FakeElement();
    const inlinePanel = mearl.setAgentPanelVisible(true, {
      layout: 'inline',
      anchor: inlineAnchor,
      context: 'Notebook context',
      key: 'notebook:repository',
      cwd: '/Users/name/project',
    });
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'agent-panel',
      requestId: '8',
      visible: true,
      layout: 'inline',
      key: 'notebook:repository',
      cwd: '/Users/name/project',
      context: 'Notebook context',
      bounds: { top: 120, left: 24, width: 640, height: 480 },
    });
    port.onmessage?.({ data: { type: 'result', requestId: '8', ok: true, result: null } });
    await expect(inlinePanel).resolves.toBeUndefined();
    port.onmessage?.({
      data: {
        type: 'agent-panel-wheel',
        key: 'notebook:repository',
        deltaX: 0,
        deltaY: 120,
      },
    });
    expect(pageScroller.scrollTop).toBe(220);

    const secondInlineAnchor = new FakeElement();
    secondInlineAnchor.rect = { top: 620, left: 24, width: 640, height: 360 };
    const secondInlinePanel = mearl.setAgentPanelVisible(true, {
      layout: 'inline',
      anchor: secondInlineAnchor,
      key: 'notebook:repository:two',
      cwd: '/Users/name/project-two',
    });
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'agent-panel',
      requestId: '9',
      visible: true,
      layout: 'inline',
      key: 'notebook:repository:two',
      cwd: '/Users/name/project-two',
      bounds: { top: 620, left: 24, width: 640, height: 360 },
    });
    port.onmessage?.({ data: { type: 'result', requestId: '9', ok: true, result: null } });
    await expect(secondInlinePanel).resolves.toBeUndefined();

    const closeFirstInlinePanel = mearl.setAgentPanelVisible(false, {
      key: 'notebook:repository',
    });
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'agent-panel',
      requestId: '10',
      visible: false,
      key: 'notebook:repository',
    });
    port.onmessage?.({ data: { type: 'result', requestId: '10', ok: true, result: null } });
    await expect(closeFirstInlinePanel).resolves.toBeUndefined();

    port.onmessage?.({
      data: {
        type: 'agent-panel-wheel',
        key: 'notebook:repository:two',
        deltaX: 0,
        deltaY: 120,
      },
    });
    expect(pageScroller.scrollTop).toBe(340);

    expect(fakeDocument.querySelector).toHaveBeenCalledWith('dialog:modal');
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'page-modal', open: false });
    const syncModal = observerCallbacks[0];
    modalDialogCount = 1;
    syncModal();
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'page-modal', open: true });
    const messageCount = port.postMessage.mock.calls.length;
    modalDialogCount = 2;
    syncModal();
    modalDialogCount = 1;
    syncModal();
    expect(port.postMessage).toHaveBeenCalledTimes(messageCount);
    modalDialogCount = 0;
    syncModal();
    syncModal();
    expect(port.postMessage).toHaveBeenCalledTimes(messageCount);
    // A replacement modal must cancel the pending restoration of the Agent panels.
    modalDialogCount = 1;
    syncModal();
    flushAnimationFrames();
    expect(port.postMessage).toHaveBeenCalledTimes(messageCount);
    modalDialogCount = 0;
    syncModal();
    secondInlineAnchor.rect = { top: 320, left: 24, width: 640, height: 360 };
    flushAnimationFrames();
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: 'page-modal',
      open: false,
      positions: [{ key: 'notebook:repository:two', bounds: secondInlineAnchor.rect }],
    });

    await expect(
      mearl.setAgentPanelVisible(true, { layout: 'workspace', anchor: {} as FakeElement }),
    ).rejects.toThrow('Agent panel anchor must be an element');
    const workspaceAnchor = new FakeElement();
    workspaceAnchor.rect = { top: 0, left: 180, width: 720, height: 600 };
    const workspacePanel = mearl.setAgentPanelVisible(true, {
      layout: 'workspace',
      anchor: workspaceAnchor,
    });
    await Promise.resolve();
    const workspaceRequest = port.postMessage.mock.calls.at(-1)![0];
    expect(workspaceRequest).toMatchObject({
      type: 'agent-panel',
      layout: 'workspace',
      visible: true,
      bounds: workspaceAnchor.rect,
    });
    expect(workspaceRequest).not.toHaveProperty('key');
    port.onmessage?.({
      data: { type: 'result', requestId: workspaceRequest.requestId, ok: true, result: null },
    });
    await expect(workspacePanel).resolves.toBeUndefined();
    workspaceAnchor.rect = { top: 0, left: 156, width: 520, height: 460 };
    observerCallbacks.at(-1)!();
    flushAnimationFrames();
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: 'agent-panel-position',
      key: 'toolbox-workspace',
      bounds: workspaceAnchor.rect,
    });
    modalDialogCount = 1;
    syncModal();
    modalDialogCount = 0;
    syncModal();
    workspaceAnchor.rect = { top: 4, left: 156, width: 520, height: 456 };
    flushAnimationFrames();
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: 'page-modal',
      open: false,
      positions: [{ key: 'toolbox-workspace', bounds: workspaceAnchor.rect }],
    });

    const workspaceTask = mearl.runAgentTask('Inspect the workspace', {
      layout: 'workspace',
      anchor: workspaceAnchor,
      key: 'sample:overview',
    });
    await Promise.resolve();
    const taskRequest = port.postMessage.mock.calls.at(-1)![0];
    expect(taskRequest).toMatchObject({
      type: 'agent-task',
      layout: 'workspace',
      key: 'sample:overview',
      bounds: workspaceAnchor.rect,
    });
    port.onmessage?.({
      data: { type: 'result', requestId: taskRequest.requestId, ok: true, result: null },
    });
    await expect(workspaceTask).resolves.toBeUndefined();
    workspaceAnchor.rect = { top: 0, left: 160, width: 520, height: 460 };
    observerCallbacks.at(-1)!();
    flushAnimationFrames();
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: 'agent-panel-position',
      key: 'sample:overview',
      bounds: workspaceAnchor.rect,
    });
    for (const [command, result] of [
      ['host.clipboard.read', { type: 'text', data: '<svg />' }],
      ['host.tab.active', { tabId: 42 }],
      ['host.clipboard.writeImage', null],
    ] as const) {
      const pending = mearl.invoke(
        command,
        command.endsWith('writeImage') ? { data: 'data:image/png;base64,cG5n' } : {},
      );
      await Promise.resolve();
      const request = port.postMessage.mock.calls.at(-1)![0];
      expect(request).toMatchObject({ type: 'invoke', command });
      port.onmessage?.({
        data: { type: 'result', requestId: request.requestId, ok: true, result },
      });
      await expect(pending).resolves.toEqual(result);
    }
    expect(mearl).not.toHaveProperty('copyImage');
    expect(mearl).not.toHaveProperty('start');
    const receive = vi.fn();
    const subscription = mearl.subscribe(
      'page',
      { instanceId: 'pi_11111111-1111-4111-8111-111111111111' },
      receive,
    );
    await Promise.resolve();
    const subscribeRequest = port.postMessage.mock.calls.at(-1)![0];
    expect(subscribeRequest).toMatchObject({
      type: 'invoke',
      command: 'host.page.events',
      input: { cursor: 0, waitMs: 0 },
    });
    port.onmessage?.({
      data: {
        type: 'result',
        requestId: subscribeRequest.requestId,
        ok: true,
        result: {
          instance: { state: 'active', target: { url: 'https://example.com/' } },
          events: [{ type: 'received', sequence: 1 }],
          nextCursor: 1,
          gap: false,
        },
      },
    });
    const unsubscribe = await subscription;
    expect(receive).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(port.postMessage.mock.calls.at(-1)![0]).toMatchObject({
        command: 'host.page.events',
        input: { cursor: 1, waitMs: 25000 },
      }),
    );
    const waitingRequest = port.postMessage.mock.calls.at(-1)![0];
    unsubscribe();
    port.onmessage?.({
      data: {
        type: 'result',
        requestId: waitingRequest.requestId,
        ok: true,
        result: {
          instance: { state: 'active', target: { url: 'https://example.com/' } },
          events: [{ type: 'received', sequence: 2 }],
          nextCursor: 2,
          gap: false,
        },
      },
    });
    await Promise.resolve();
    expect(receive).toHaveBeenCalledOnce();
    const bytes = Buffer.from(JSON.stringify({ value: { text: '完整译文'.repeat(100000) } }));
    const reference = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      chunks: 2,
    };
    let corrupt = false;
    port.postMessage.mockImplementation(message => {
      if (message.type !== 'invoke') return;
      const result =
        message.command === 'host.task.get'
          ? { state: 'success', result: reference }
          : {
              taskId: 'task',
              index: message.input.index,
              ...reference,
              data: (corrupt
                ? Buffer.alloc(bytes.length / 2, 32)
                : bytes.subarray(
                    message.input.index * (bytes.length / 2),
                    (message.input.index + 1) * (bytes.length / 2),
                  )
              ).toString('base64'),
            };
      queueMicrotask(() =>
        port.onmessage?.({
          data: { type: 'result', requestId: message.requestId, ok: true, result },
        }),
      );
    });
    await expect(mearl.readTaskResult('task')).resolves.toEqual({
      text: '完整译文'.repeat(100000),
    });
    corrupt = true;
    await expect(mearl.readTaskResult('task')).rejects.toThrow('integrity');
  });

  it('rejects missing entries, path traversal, and builtin names', () => {
    for (const name of ['../outside', 'check', 'guide', 'page_click', 'capture_checkpoint', '__internal']) {
      expect(() => registerPlugin(name, entry)).toThrow('PLUGIN_INVALID_NAME');
    }
    expect(() => registerPlugin('missing', join(directory, 'absent'))).toThrow(
      'PLUGIN_ENTRY_MISSING',
    );
    const rootEntryOnly = join(directory, 'root-entry-only');
    mkdirSync(rootEntryOnly);
    writeFileSync(join(rootEntryOnly, 'main.mjs'), 'export default () => {};');
    expect(() => registerPlugin('legacy', rootEntryOnly)).toThrow('scripts/main.mjs');
    expect(findPluginEntry('missing')).toBeUndefined();
    expect(findPluginEntry('legacy')).toBeUndefined();
  });

  it('isolates damaged records from other plugins and reports the targeted record', () => {
    registerPlugin('sample', entry);
    writeFileSync(join(directory, 'registry/broken.json'), '{');
    expect(findPluginEntry('sample')).toBe(entry);
    expect(() => findPluginEntry('broken')).toThrow('PLUGIN_REGISTRY_INVALID');
  });

  it('unregisters plugins idempotently without touching their entry files', () => {
    registerPlugin('sample', entry);
    expect(unregisterPlugin('sample')).toBe(true);
    expect(findPluginEntry('sample')).toBeUndefined();
    expect(readFileSync(entry, 'utf8')).toContain("app.command('read <url>'");
    expect(unregisterPlugin('sample')).toBe(false);
    expect(() => unregisterPlugin('../outside')).toThrow('PLUGIN_INVALID_NAME');
  });
});

describe('plugin runtime', () => {
  it('provides generic page-script data execution only while a plugin command is running', async () => {
    const scriptEntry = join(directory, 'scripts', 'page-script.mjs');
    writeFileSync(
      scriptEntry,
      `export default app => { app.command('read', () => app.invoke('page_eval', { tabId: 7, executionWorld: 'isolated', worldId: 'sample-tool', expression: 'data => data.value', args: [{ value: 42 }], observe: false })); };`,
    );
    const invoke = vi.fn().mockResolvedValue({ result: 42 });
    const plugin = await loadPlugin(scriptEntry, { invoke, options: {}, progress: () => {} });
    expect(invoke).not.toHaveBeenCalled();
    await expect(plugin.run(['read'])).resolves.toEqual({ result: 42 });
    expect(invoke).toHaveBeenCalledWith(
      'page_eval',
      expect.objectContaining({
        executionWorld: 'isolated',
        worldId: 'sample-tool',
        expression: 'data => data.value',
        args: [{ value: 42 }],
        observe: false,
      }),
      {},
    );
  });

  it('leaves argument transmission to the SDK adapter for plugin commands', async () => {
    const scriptEntry = join(directory, 'scripts', 'page-script-sdk.mjs');
    writeFileSync(
      scriptEntry,
      `export default app => { app.command('read', () => app.invoke('page_eval', { tabId: 7, expression: 'data => data.length', args: ['x'.repeat(100000)] })); };`,
    );
    const client = new UnifiedClient();
    const routed = vi.spyOn(client as any, 'invokeRouted');
    const pageWindow = {};
    routed.mockImplementation(async (_action: string, payload: any, options: any) => {
      expect(options.browser).toBe('mearl:local:sample');
      return { result: new Function('window', `return ${payload.expression}`)(pageWindow) };
    });
    const plugin = await loadPlugin(scriptEntry, {
      invoke: (action, payload, options) => client.invoke(action, payload, options),
      options: {},
      progress: () => {},
    });
    (client as any).defaultBrowser = 'mearl:local:sample';
    await expect(plugin.run(['read'])).resolves.toEqual({ result: 100000 });
    expect(routed.mock.calls.length).toBeGreaterThan(2);
    expect(pageWindow).toEqual({});
  });

  it('keeps toolbox commands out of public help and execution while allowing page calls', async () => {
    const toolboxEntry = join(directory, 'scripts', 'private-toolbox.mjs');
    writeFileSync(
      toolboxEntry,
      `
      export const toolbox = { version: 1, title: 'Test', page: { type: 'sandbox', entry: 'assets/toolbox/index.html', commands: ['echo', 'chunk', 'nested'] } };
      export default app => {
        app.command('echo [value]', input => input);
        app.command('file <path>', input => input);
        app.toolboxCommand('chunk <index>', input => {
          app.progress('reading chunk');
          return app.invoke('send_request', input);
        }, '分块读取', ['chunk 0']);
        app.toolboxCommand('nested', () => app.invoke('private-child', { command: 'chunk', input: { index: 0 } }));
      };
    `,
    );
    const context = { invoke: vi.fn().mockResolvedValue({ ok: true }) };
    const progress = vi.fn();
    const plugin = await loadPlugin(toolboxEntry, { ...context, options: {}, progress });
    registerPlugin('private-tool', toolboxEntry, undefined, { toolbox: plugin.toolbox });
    registerPlugin('private-child', toolboxEntry, undefined, { toolbox: plugin.toolbox });
    for (const help of [
      plugin.help('mearl private-tool'),
      plugin.commandHelp('mearl private-tool'),
    ]) {
      expect(help).toContain('echo [value]');
      expect(help).toContain('file <path>');
      expect(help).not.toContain('chunk');
      expect(help).not.toContain('nested');
    }
    expect(() => plugin.help('mearl private-tool', 'chunk')).toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
    await expect(plugin.run(['chunk', '0'])).rejects.toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
    await expect(
      plugin.run([], { command: 'chunk', input: { index: 0, toolboxPage: true } }),
    ).rejects.toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
    await expect(
      invokeRegisteredPlugin('private-tool', { command: 'chunk', input: { index: 0 } }, context),
    ).rejects.toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
    const client = new UnifiedClient();
    await expect(
      client.invokePlugin('private-tool', { command: 'chunk', input: { index: 0 } }),
    ).rejects.toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(runMearlCli(['private-tool', 'chunk', '0'])).resolves.toBe(2);
    await expect(
      runMearlCli([
        'private-tool',
        '--payload',
        JSON.stringify({ command: 'chunk', input: { index: 0 } }),
      ]),
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('PLUGIN_COMMAND_TOOLBOX_ONLY'));
    expect(context.invoke).not.toHaveBeenCalled();

    await expect(
      invokeRegisteredToolboxPlugin(
        'private-tool',
        { command: 'chunk', input: { index: 0 } },
        context,
        { onProgress: progress },
      ),
    ).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenCalledWith('reading chunk');
    expect(context.invoke).toHaveBeenCalledWith('send_request', { index: 0 }, {});
    await expect(plugin.runToolbox({ command: 'echo', input: { value: false } })).resolves.toEqual({
      value: false,
    });
    await expect(plugin.runToolbox({ command: 'chunk', input: {} })).rejects.toThrow(
      '缺少必填参数',
    );
    await expect(
      plugin.runToolbox({ command: 'file', input: { path: '/tmp/file' } }),
    ).rejects.toThrow('PLUGIN_COMMAND_NOT_ALLOWED');
    await expect(
      invokeRegisteredToolboxPlugin('private-tool', { command: 'nested', input: {} }, context),
    ).rejects.toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
  });

  it.each([
    `export default app => app.toolboxCommand('chunk', () => ({}));`,
    `export const toolbox = { version: 1, title: 'Test', page: { type: 'sandbox', entry: 'assets/toolbox/index.html', commands: ['echo'] } }; export default app => { app.command('echo', () => ({})); app.toolboxCommand('chunk', () => ({})); };`,
    `export default app => { app.command('echo', () => ({})); app.toolboxCommand('echo', () => ({})); };`,
  ])('rejects invalid toolbox-only registrations: %s', async source => {
    const toolboxEntry = join(directory, 'scripts', 'invalid-toolbox.mjs');
    writeFileSync(toolboxEntry, source);
    await expect(
      loadPlugin(toolboxEntry, { options: {}, invoke: vi.fn(), progress: vi.fn() }),
    ).rejects.toThrow('PLUGIN_LOAD_FAILED');
  });

  it('supports a toolbox-only Python plugin and decorator registration', async () => {
    const pythonEntry = join(directory, 'scripts', 'toolbox.py');
    writeFileSync(
      pythonEntry,
      `
toolbox = {"version": 1, "title": "Python Tool", "page": {"type": "sandbox", "entry": "assets/toolbox/index.html", "commands": ["chunk", "release"]}}
def register(app):
    @app.toolboxCommand("chunk <index>", description="read chunk")
    def chunk(input):
        app.progress("reading")
        return app.invoke("send_request", input)
    app.toolboxCommand("release", lambda input: {"released": True})
`,
    );
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const progress = vi.fn();
    const plugin = await loadPlugin(pythonEntry, { options: {}, invoke, progress });
    expect(plugin.commandHelp('mearl python')).toBe('');
    await expect(plugin.run(['chunk', '0'])).rejects.toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
    await expect(plugin.runToolbox({ command: 'chunk', input: { index: 0 } })).resolves.toEqual({
      ok: true,
    });
    await expect(plugin.runToolbox({ command: 'release', input: {} })).resolves.toEqual({
      released: true,
    });
    expect(progress).toHaveBeenCalledWith('reading');
  });

  it('loads toolbox metadata and requires its declared commands to exist', async () => {
    const toolboxEntry = join(directory, 'scripts', 'toolbox.mjs');
    writeFileSync(
      toolboxEntry,
      `export const toolbox = { version: 1, title: 'Workspace Notes', icon: 'git-branch', page: { type: 'sandbox', entry: 'assets/toolbox/index.html', commands: ['echo'] } };
       export default app => app.command('echo [value]', input => input);`,
    );
    const plugin = await loadPlugin(toolboxEntry, {
      options: {},
      invoke: vi.fn(),
      progress: vi.fn(),
    });
    expect(plugin.toolbox).toEqual({
      version: 1,
      title: 'Workspace Notes',
      icon: 'git-branch',
      page: {
        type: 'sandbox',
        entry: 'assets/toolbox/index.html',
        commands: ['echo'],
      },
    });

    writeFileSync(
      toolboxEntry,
      `export const toolbox = { version: 1, title: 'Broken', page: { type: 'sandbox', entry: 'assets/toolbox/index.html', commands: ['missing'] } };
       export default app => app.command('echo', () => ({}));`,
    );
    const changedAt = new Date(Date.now() + 2_000);
    utimesSync(toolboxEntry, changedAt, changedAt);
    await expect(
      loadPlugin(toolboxEntry, { options: {}, invoke: vi.fn(), progress: vi.fn() }),
    ).rejects.toThrow('toolbox 命令未注册');

    writeFileSync(
      toolboxEntry,
      `export const toolbox = { version: 1, title: 'Workspace Notes', page: { type: 'sandbox', entry: 'assets/toolbox/index.html', commands: ['list', 'create', 'delete'] } };
       export default app => {
         app.command('list', () => ({ items: [] }));
         app.command('create <name>', input => ({ item: input }));
         app.command('delete <id>', input => ({ item: input }));
       };`,
    );
    utimesSync(toolboxEntry, new Date(Date.now() + 4_000), new Date(Date.now() + 4_000));
    await expect(
      loadPlugin(toolboxEntry, { options: {}, invoke: vi.fn(), progress: vi.fn() }),
    ).resolves.toMatchObject({
      toolbox: {
        page: {
          type: 'sandbox',
          entry: 'assets/toolbox/index.html',
          commands: ['list', 'create', 'delete'],
        },
      },
    });
  });

  it('preserves JSON types and sends both input forms to the same handler', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const plugin = await loadPlugin(entry, { options: {}, invoke, progress: vi.fn() });
    expect(plugin.description).toBe('Short plugin summary');
    expect(plugin.version).toBe('1.2.3');
    await plugin.run(['read', 'https://example.com']);
    await plugin.run([], { command: 'read', input: { url: 'https://example.com' } });
    expect(invoke.mock.calls[0]).toEqual(invoke.mock.calls[1]);
    const input = { value: false, count: 0, nested: { list: [1, true, 'quote"'] } };
    expect(await plugin.run([], { command: 'echo', input })).toEqual(input);
    expect(await plugin.run(['files', 'a', 'b'])).toEqual({ paths: ['a', 'b'] });
    expect(await plugin.run(['echo'])).toEqual({});
  });

  it('reads the version and executes commands with a disabled Skill manifest', async () => {
    setSkillEnabled(directory, false);
    const plugin = await loadPlugin(entry, { options: {}, invoke: vi.fn(), progress: vi.fn() });
    expect(plugin.version).toBe('1.2.3');
    await expect(plugin.run([], { command: 'echo', input: { count: 3 } })).resolves.toEqual({
      count: 3,
    });
  });

  it('merges named CLI fields without depending on positional order', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const plugin = await loadPlugin(entry, { options: {}, invoke, progress: vi.fn() });

    await plugin.run(['read'], undefined, {
      url: 'https://example.com',
      responseType: 'json',
    });
    expect(invoke).toHaveBeenCalledWith(
      'send_request',
      {
        url: 'https://example.com',
        responseType: 'json',
      },
      {},
    );
    await expect(
      plugin.run(['read', 'https://example.com'], undefined, { url: 'https://duplicate.com' }),
    ).rejects.toThrow('参数不能重复传入: url');
  });

  it('loads Python entries with the same commands, host calls, progress, and options', async () => {
    const pythonDirectory = join(directory, 'python-skill');
    const pythonEntry = join(pythonDirectory, 'scripts', 'main.py');
    mkdirSync(dirname(pythonEntry), { recursive: true });
    writeFileSync(
      join(pythonDirectory, 'SKILL.md'),
      '---\nname: python-sample\nversion: "2.0.0"\n---\n',
    );
    writeFileSync(
      pythonEntry,
      `name = "python-sample"
description = "Python plugin"

def register(app):
    def read(input):
        app.progress("reading " + input["url"])
        response = app.invoke(
            "send_request",
            {"url": input["url"]},
            {"timeoutSec": 3},
        )
        return {
            "input": input,
            "options": dict(app.options),
            "response": response,
        }

    @app.command("echo [value]", description="回显")
    async def echo(input):
        return input

    app.command("read <url>", read, "读取")
`,
    );
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: 'ok' });
    const progress = vi.fn();
    const plugin = await loadPlugin(pythonEntry, {
      options: { browser: 'work' },
      invoke,
      progress,
    });

    expect(plugin.name).toBe('python-sample');
    expect(plugin.description).toBe('Python plugin');
    expect(plugin.version).toBe('2.0.0');
    expect(plugin.help('mearl python-sample')).toContain('read <url>');
    await expect(plugin.run([], { command: 'echo', input: { value: false } })).resolves.toEqual({
      value: false,
    });
    await expect(plugin.run(['read', 'https://example.com'])).resolves.toEqual({
      input: { url: 'https://example.com' },
      options: { browser: 'work' },
      response: { status: 200, body: 'ok' },
    });
    expect(invoke).toHaveBeenCalledWith(
      'send_request',
      { url: 'https://example.com' },
      { timeoutSec: 3 },
    );
    expect(progress).toHaveBeenCalledWith('reading https://example.com');

    invoke.mockRejectedValueOnce(new PluginError('PLUGIN_BRIDGE_FAILED', 'nested failure'));
    await expect(plugin.run(['read', 'https://example.com/fail'])).rejects.toMatchObject({
      code: 'PLUGIN_BRIDGE_FAILED',
      message: 'PLUGIN_BRIDGE_FAILED: nested failure',
    });
  });

  it('reports an actionable error when the Python interpreter is unavailable', async () => {
    const pythonEntry = join(directory, 'main.py');
    writeFileSync(pythonEntry, 'def register(app):\n    pass\n');
    vi.stubEnv('MEARL_PYTHON', join(directory, 'missing-python'));
    await expect(
      loadPlugin(pythonEntry, { options: {}, invoke: vi.fn(), progress: vi.fn() }),
    ).rejects.toThrow('Python 3.9');
  });

  it('validates both input forms without dispatching malformed requests', async () => {
    const invoke = vi.fn();
    const plugin = await loadPlugin(entry, { options: {}, invoke, progress: vi.fn() });
    for (const [args, payload] of [
      [['read'], undefined],
      [[], { command: 'read', input: {} }],
      [['read', 'url', 'extra'], undefined],
      [['read', 'url'], { command: 'read', input: { url: 'url' } }],
      [[], { command: 'read', input: [] }],
      [[], { command: 'files', input: { paths: 'a' } }],
      [[], null],
    ] as [string[], unknown][]) {
      await expect(plugin.run(args, payload)).rejects.toThrow('PLUGIN_INVALID_INPUT');
    }
    await expect(plugin.run(['missing'])).rejects.toThrow('PLUGIN_COMMAND_NOT_FOUND');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps progress inside command execution and forbids side effects during registration', async () => {
    const invoke = vi.fn();
    const progress = vi.fn();
    const plugin = await loadPlugin(entry, { options: {}, invoke, progress });
    const help = plugin.help('mearl sample');
    expect(plugin.commandHelp('mearl sample')).toContain('mearl sample read <url>  读取');
    expect(plugin.commandHelp('mearl sample')).not.toContain('常用选项');
    expect(help).toContain('用法：');
    expect(help).toContain('mearl sample read <url>');
    expect(help).toContain('mearl sample read https://example.com');
    expect(help).not.toContain('常用选项');
    expect(help).not.toContain('--payload');
    expect(plugin.help('mearl sample', 'echo')).not.toContain('read https://example.com');
    expect(help).not.toContain('--connector');
    expect(help).not.toContain('--local');
    expect(help).not.toContain('--cdp');
    expect(help).not.toContain('--server');
    expect(invoke).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    await expect(plugin.run(['progress', 'loading'])).resolves.toEqual({ message: 'loading' });
    expect(progress).toHaveBeenCalledWith('loading');
    await expect(plugin.run(['structured-progress'])).resolves.toBeUndefined();
    expect(progress).toHaveBeenCalledWith({
      message: 'publishing',
      data: { phase: 'publishing', repositoryId: 'sample' },
    });
    const bad = join(directory, 'bad.mjs');
    writeFileSync(bad, `export default app => { app.invoke('tab_list'); };`);
    await expect(loadPlugin(bad, { options: {}, invoke, progress })).rejects.toThrow(
      'PLUGIN_LOAD_FAILED',
    );
    const badProgress = join(directory, 'bad-progress.mjs');
    writeFileSync(badProgress, `export default app => { app.progress('loading'); };`);
    await expect(loadPlugin(badProgress, { options: {}, invoke, progress })).rejects.toThrow(
      'PLUGIN_LOAD_FAILED',
    );
    const invalidProgressData = join(directory, 'invalid-progress-data.mjs');
    writeFileSync(
      invalidProgressData,
      `export default app => app.command('run', () => {
        const data = {};
        data.self = data;
        app.progress({ message: 'loading', data });
      });`,
    );
    const invalidProgressPlugin = await loadPlugin(invalidProgressData, {
      options: {},
      invoke,
      progress,
    });
    await expect(invalidProgressPlugin.run(['run'])).rejects.toThrow(
      'app.progress data 必须是可 JSON 序列化的对象',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('distinguishes missing entry from broken imports and invalid exports', async () => {
    const context = { options: {}, invoke: vi.fn(), progress: vi.fn() };
    await expect(loadPlugin(join(directory, 'absent.mjs'), context)).rejects.toThrow(
      'PLUGIN_ENTRY_MISSING',
    );
    for (const [name, source] of [
      ['invalid', 'export default 123;'],
      [
        'description',
        `export const description = 123; export default app => app.command('a', () => {});`,
      ],
      ['import', `import './missing.mjs'; export default () => {};`],
      [
        'duplicate',
        `export default app => { app.command('a', () => {}); app.command('a', () => {}); };`,
      ],
    ]) {
      const file = join(directory, `${name}.mjs`);
      writeFileSync(file, source);
      await expect(loadPlugin(file, context)).rejects.toThrow('PLUGIN_LOAD_FAILED');
    }
  });

  it('reloads updated plugin source in a long-lived process', async () => {
    const reloadEntry = join(directory, 'scripts', 'reload.mjs');
    const context = { options: {}, invoke: vi.fn(), progress: vi.fn() };
    writeFileSync(reloadEntry, `export default app => app.command('value', () => ({ value: 1 }));`);
    const first = await loadPlugin(reloadEntry, context);
    await expect(first.run(['value'])).resolves.toEqual({ value: 1 });

    writeFileSync(reloadEntry, `export default app => app.command('value', () => ({ value: 2 }));`);
    const changedAt = new Date(Date.now() + 2_000);
    utimesSync(reloadEntry, changedAt, changedAt);
    const second = await loadPlugin(reloadEntry, context);
    await expect(second.run(['value'])).resolves.toEqual({ value: 2 });
  });

  it('composes registered plugins with inherited options and rejects invocation cycles', async () => {
    const childEntry = join(directory, 'scripts', 'child.mjs');
    writeFileSync(
      childEntry,
      `export default app => {
        app.command('echo', input => ({ input, options: app.options }));
        app.command('cycle', input => app.invoke('sample', { command: 'dependency', input }));
      };`,
    );
    registerPlugin('sample', entry);
    registerPlugin('child', childEntry);
    const invoke = vi.fn();

    await expect(
      invokeRegisteredPlugin(
        'sample',
        { command: 'dependency', input: { value: 'nested' } },
        { invoke },
        { browser: 'work', timeoutSec: 9 },
      ),
    ).resolves.toEqual({
      input: { value: 'nested' },
      options: { browser: 'work', timeoutSec: 9 },
    });
    expect(invoke).not.toHaveBeenCalled();

    await expect(
      invokeRegisteredPlugin('child', { command: 'cycle', input: {} }, { invoke }),
    ).rejects.toThrow('PLUGIN_INVOCATION_CYCLE');
  });

  it('invokes only registered plugins and centralizes routing and action failures', async () => {
    const invoke = vi.fn().mockResolvedValue({ body: 'ok' });
    registerPlugin('sample', entry);

    await expect(
      invokeRegisteredPlugin(
        'sample',
        { command: 'read', input: { url: 'https://example.com' } },
        { invoke },
        { browser: 'remote', connector: 'office', timeoutSec: 7 },
      ),
    ).resolves.toEqual({ body: 'ok' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'send_request',
      { url: 'https://example.com' },
      { browser: 'remote', connector: 'office', timeoutSec: 7 },
    );

    invoke.mockResolvedValueOnce({
      action: { success: false, error: 'target missing', stage: 'precondition' },
    });
    await expect(
      invokeRegisteredPlugin(
        'sample',
        { command: 'read', input: { url: 'https://example.com' } },
        { invoke },
      ),
    ).rejects.toThrow('target missing');
    await expect(
      invokeRegisteredPlugin('missing', { command: 'read', input: {} }, { invoke }),
    ).rejects.toThrow('PLUGIN_NOT_REGISTERED');
  });

  it.each(['identity', 'headers'])(
    'installs a missing %s plugin once and retries it through the same runtime',
    async name => {
      const pluginEntry = join(directory, 'scripts', `${name}.mjs`);
      writeFileSync(
        pluginEntry,
        `export default app => app.command('check', () => ({ authenticated: true }));`,
      );
      const ensurePlugin = vi.fn(async pluginName => {
        registerPlugin(pluginName, pluginEntry);
      });
      const invoke = vi.fn();

      await expect(
        invokeRegisteredPlugin(name, { command: 'check', input: {} }, { invoke, ensurePlugin }),
      ).resolves.toEqual({ authenticated: true });
      expect(ensurePlugin).toHaveBeenCalledExactlyOnceWith(name, undefined);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('does not install an unregistered plugin outside the automatic allowlist', async () => {
    const ensurePlugin = vi.fn();
    const invoke = vi.fn();

    await expect(
      invokeRegisteredPlugin('sample-docs', { command: 'read', input: {} }, { invoke, ensurePlugin }),
    ).rejects.toThrow('PLUGIN_NOT_REGISTERED');
    expect(ensurePlugin).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exposes registered plugin invocation through the client SDK', async () => {
    registerPlugin('sample', entry);
    const client = new UnifiedClient();
    const invoke = vi.spyOn(client, 'invoke').mockResolvedValue({ body: 'sdk' });

    await expect(
      client.invokePlugin(
        'sample',
        { command: 'read', input: { url: 'https://example.com' } },
        { browser: 'work' },
      ),
    ).resolves.toEqual({ body: 'sdk' });
    expect(invoke).toHaveBeenCalledWith(
      'send_request',
      { url: 'https://example.com' },
      { browser: 'work' },
    );
  });
});

describe('plugin CLI', () => {
  it('aligns registered plugin descriptions with the top-level check command', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registerPlugin('sample', entry, 'Short plugin summary');
    writeFileSync(join(directory, 'registry/broken.json'), '{');

    expect(await runMearlCli([], { clientVersion: '9.9.9' })).toBe(1);
    const usage = String(error.mock.calls.at(-1)?.[0]);
    expect(usage).toContain('已注册插件：');
    expect(usage).toContain(`  ${'sample'.padEnd(22)}Short plugin summary`);
    const lines = usage.split('\n');
    expect(lines.find(line => line.startsWith('  sample'))?.indexOf('Short')).toBe(
      lines.find(line => line.startsWith('  check'))?.indexOf('检查'),
    );
    expect(usage).not.toContain('skill trigger details');
    expect(usage).toContain('  broken');
    expect(usage).not.toContain('官方插件');
    expect(usage).not.toContain('  identity');
    expect(usage).not.toContain('  accounts');
  });

  it('reports a loadable plugin version offline and does not confuse missing plugins with the client version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke');

    registerPlugin('sample', entry);
    expect(await runMearlCli(['sample', '--version'], { clientVersion: '9.9.9' })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('1.2.3');
    expect(invoke).not.toHaveBeenCalled();

    expect(await runMearlCli(['missing', '--version'], { clientVersion: '9.9.9' })).toBe(2);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('PLUGIN_NOT_REGISTERED'));
    expect(log).not.toHaveBeenCalledWith('9.9.9');
  });

  it('runs the actual public tab-manager entry with both syntaxes through the same browser context', async () => {
    const tabs = fileURLToPath(new URL('../../../../../../skills/browser-tab-manager/scripts/main.mjs', import.meta.url));
    registerPlugin('tabs', tabs);
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke').mockResolvedValue({ tabs: [
      { id: 1, url: 'https://example.com/', controlled: true },
      { id: 2, url: 'chrome://settings/', controlled: false },
    ] });
    vi.spyOn(UnifiedClient.prototype, 'disconnect');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runMearlCli(['tabs', 'summary', '--browser', 'work'])).toBe(0);
    expect(await runMearlCli(['tabs', '--payload', JSON.stringify({ command: 'summary', input: {} }), '--browser', 'work'])).toBe(0);
    expect(write.mock.calls.map(([content]) => JSON.parse(String(content)))).toEqual([
      { count: 2, mearlCount: 1, groups: [] }, { count: 2, mearlCount: 1, groups: [] },
    ]);
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0]).toEqual(invoke.mock.calls[1]);
    expect(invoke.mock.calls.every(([, , options]) => options?.browser === 'work')).toBe(true);
  });
  it('propagates browser routing and output through the client and always disconnects', async () => {
    registerPlugin('sample', entry);
    const invoke = vi
      .spyOn(UnifiedClient.prototype, 'invoke')
      .mockResolvedValue({ content: 'done' });
    const disconnect = vi.spyOn(UnifiedClient.prototype, 'disconnect');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const output = join(directory, 'result.json');
    expect(
      await runMearlCli([
        'sample',
        'read',
        'https://example.com',
        '--browser',
        'remote',
        '--connector',
        'office',
        '--timeout',
        '7',
        '--output',
        output,
      ]),
    ).toBe(0);
    expect(invoke).toHaveBeenCalledWith(
      'send_request',
      { url: 'https://example.com' },
      { browser: 'remote', connector: 'office', timeoutSec: 7 },
    );
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ content: 'done' });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('passes --name=value options to plugin input', async () => {
    registerPlugin('sample', entry);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(
      await runMearlCli(['sample', 'echo', '--count=2', '--enabled=true', '--responseType=json']),
    ).toBe(0);
    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toEqual({
      count: '2',
      enabled: 'true',
      responseType: 'json',
    });
    expect(await runMearlCli(['sample', 'echo', '--all'])).toBe(0);
    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toEqual({ all: true });
  });

  it('hides plugin progress by default and writes it to stderr in verbose mode', async () => {
    registerPlugin('sample', entry);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runMearlCli(['sample', 'progress', 'loading'])).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(await runMearlCli(['sample', 'progress', 'loading', '--verbose'])).toBe(0);
    expect(write).toHaveBeenCalledWith('loading\n');
    write.mockClear();
    expect(await runMearlCli(['sample', 'structured-progress', '--verbose'])).toBe(0);
    expect(write).toHaveBeenCalledWith('publishing\n');
  });

  it('keeps help offline and does not expose a generic confirmation option', async () => {
    registerPlugin('sample', entry);
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runMearlCli(['sample', 'read', '--help'])).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('mearl sample read https://example.com'),
    );
    const payload = JSON.stringify({ command: 'write', input: { confirm: true } });
    expect(await runMearlCli(['sample', '--payload', payload])).toBe(0);
    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toMatchObject({
      written: true,
      input: { confirm: true },
    });
    expect(await runMearlCli(['sample', '--payload', payload, '--confirm'])).toBe(2);
    expect(await runMearlCli(['sample', 'unsuccessful'])).toBe(1);
    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toEqual({
      success: false,
      reason: 'rejected',
    });
    expect(await runMearlCli(['sample', 'fail'])).toBe(1);
  });

  it('reports missing registration and stale entry without invoking any browser action', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMearlCli(['sample', 'read', 'url'])).toBe(2);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('PLUGIN_NOT_REGISTERED'));
    registerPlugin('sample', entry);
    writeFileSync(
      join(directory, 'registry', 'sample.json'),
      `${JSON.stringify({ entry: join(directory, 'main.mjs') })}\n`,
    );
    expect(await runMearlCli(['sample', 'read', 'url'])).toBe(2);
    const message = String(error.mock.calls.at(-1)?.[0]);
    expect(message).toContain('PLUGIN_ENTRY_MISSING: 插件入口已失效');
    expect(message).toContain('插件：sample');
    expect(message).toContain(`入口：${join(directory, 'main.mjs')}`);
    expect(message).toContain('卸载命令：npx @mearl/setup plugin uninstall sample');
    expect(message).not.toContain('卸载并清理注册');
    expect(message).not.toContain('plugin install');
    expect(message).not.toContain('重新注册');
    expect(message).not.toContain('plugin uninstall <name>');
    // 已损坏的插件不会阻止内置命令帮助。
    expect(await runMearlCli(['tab_list', '--help'])).toBe(0);
  });
});
