import { describe, expect, it, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invokeRegisteredPlugin, loadPlugin, registerPlugin } from '@mearl/client/plugin';
import {
  handleToolboxTask,
  invokeToolboxPluginTool,
  listToolboxPluginTools,
  openToolboxPluginTool,
  readToolboxPluginPageChunk,
  resolveToolboxPluginAgent,
  uninstallToolboxPlugin,
  setToolboxSkillEnabled,
} from '../toolbox-service.js';

const hash = 'a'.repeat(64);

function toolboxRegistration(commands = ['list', 'create', 'delete']) {
  return {
    entry: '/skills/notebook/scripts/main.mjs',
    toolbox: {
      version: 1 as const,
      title: 'Workspace Notes',
      agent: {
        skill: 'notebook-skill',
        layout: 'workspace' as const,
        pageElementActions: false,
      },
      page: {
        type: 'sandbox' as const,
        runtime: 'preact' as const,
        entry: 'assets/toolbox/index.html',
        commands,
      },
    },
    pageBundle: { hash, size: 1200, chunks: 2 },
  };
}

describe('toolbox service', () => {
  it('executes page-only handlers through the immediate toolbox route', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-toolbox-command-'));
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
    try {
      mkdirSync(join(directory, 'scripts'));
      mkdirSync(join(directory, 'assets'));
      const entry = join(directory, 'scripts', 'main.mjs');
      writeFileSync(join(directory, 'assets', 'index.html'), '<!doctype html><body>Test</body>');
      writeFileSync(
        entry,
        `
        export const toolbox = { version: 1, title: 'Test', page: { type: 'sandbox', entry: 'assets/index.html', commands: ['chunk'] } };
        export default app => app.toolboxCommand('chunk', input => {
          app.progress('reading');
          return { index: input.index };
        });
      `,
      );
      const context = { invoke: vi.fn() };
      const loaded = await loadPlugin(entry, { ...context, options: {}, progress: vi.fn() });
      registerPlugin('page-only', entry, undefined, { toolbox: loaded.toolbox });
      await expect(
        invokeRegisteredPlugin('page-only', { command: 'chunk', input: {} }, context),
      ).rejects.toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
      await expect(
        invokeToolboxPluginTool('plugin:page-only', 'chunk', { index: 1 }, context),
      ).resolves.toEqual({ result: { index: 1 } });
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);

  it.each(['popup', 'tab', 'both'] as const)(
    'exposes the %s display mode in list and open metadata',
    async displayMode => {
      const registration = toolboxRegistration();
      const dependencies = {
        findRegistration: () => ({
          ...registration,
          toolbox: { ...registration.toolbox, displayMode },
        }),
        listPlugins: () => ['notebook'],
      };
      const list = await listToolboxPluginTools(dependencies);
      expect(list.tools[0].displayMode).toBe(displayMode);
      const opened = await openToolboxPluginTool(
        'plugin:notebook',
        { invoke: vi.fn() },
        dependencies,
      );
      expect(opened.displayMode).toBe(displayMode);
    },
  );
  it('lists registered UI plugins in their declared order and skips ordinary plugins', async () => {
    const registrations: Record<string, any> = {
      ordinary: { entry: '/skills/ordinary/scripts/main.mjs' },
      release: {
        ...toolboxRegistration(['status']),
        entry: '/skills/release/scripts/main.mjs',
        toolbox: { ...toolboxRegistration(['status']).toolbox, title: 'Release', order: 200 },
      },
      notebook: {
        ...toolboxRegistration(),
        toolbox: { ...toolboxRegistration().toolbox, order: 100 },
      },
      'notebook-skill': {
        ...toolboxRegistration(),
        toolbox: { ...toolboxRegistration().toolbox, order: 100 },
      },
    };
    expect(
      (
        await listToolboxPluginTools({
          listPlugins: () => ['ordinary', 'release', 'notebook-skill', 'notebook'],
          findRegistration: name => registrations[name],
        })
      ).tools.map(tool => tool.id),
    ).toEqual(['plugin:notebook', 'plugin:release']);
  });

  it('opens the registered sandbox page without invoking a launch command', async () => {
    const context = { invoke: vi.fn() };
    await expect(
      openToolboxPluginTool('plugin:notebook', context, {
        findRegistration: () => toolboxRegistration(),
      }),
    ).resolves.toEqual({
      title: 'Workspace Notes',
      agent: { enabled: true, layout: 'workspace', pageElementActions: false },
      page: { type: 'sandbox', runtime: 'preact', hash, size: 1200, chunks: 2 },
    });
    expect(context.invoke).not.toHaveBeenCalled();
  });

  it('refreshes entry metadata when listing and page assets when opening', async () => {
    const registration = toolboxRegistration();
    const refreshRegistration = vi.fn().mockResolvedValue({
      ...registration,
      toolbox: { ...registration.toolbox, title: 'Updated tool' },
    });
    const dependencies = { listPlugins: () => ['notebook'], refreshRegistration };
    expect((await listToolboxPluginTools(dependencies)).tools[0].title).toBe('Updated tool');
    expect(refreshRegistration).toHaveBeenCalledWith('notebook');
    expect(
      await openToolboxPluginTool('plugin:notebook', { invoke: vi.fn() }, dependencies),
    ).toMatchObject({ title: 'Updated tool' });
    expect(refreshRegistration).toHaveBeenCalledWith('notebook', true);
  });

  it('keeps valid list entries when refreshing fails and skips corrupt registrations', async () => {
    const refreshRegistration = vi.fn().mockRejectedValue(new Error('incomplete update'));
    const findRegistration = (name: string) => {
      if (name === 'corrupt') throw new Error('invalid registration');
      return toolboxRegistration();
    };
    const dependencies = {
      listPlugins: () => ['notebook', 'corrupt'],
      refreshRegistration,
      findRegistration,
    };
    expect((await listToolboxPluginTools(dependencies)).tools.map(tool => tool.id)).toEqual([
      'plugin:notebook',
    ]);
    await expect(
      openToolboxPluginTool('plugin:notebook', { invoke: vi.fn() }, dependencies),
    ).rejects.toThrow('incomplete update');
  });

  it('offers updates only when the registered page belongs to the global Skill', async () => {
    const registration = toolboxRegistration();
    await expect(
      openToolboxPluginTool(
        'plugin:notebook',
        { invoke: vi.fn() },
        {
          findRegistration: () => ({
            ...registration,
            entry: join(homedir(), '.agents', 'skills', 'notebook-skill', 'scripts', 'main.mjs'),
          }),
        },
      ),
    ).resolves.toMatchObject({
      skillUpdate: { name: 'notebook-skill', scope: 'global' },
    });
    await expect(
      openToolboxPluginTool(
        'plugin:notebook',
        { invoke: vi.fn() },
        {
          findRegistration: () => registration,
        },
      ),
    ).resolves.not.toHaveProperty('skillUpdate');
  });

  it.each(['tinypng-compress', 'design-overlay', 'browser-tab-manager'])(
    'offers updates for global %s without requiring an Agent panel',
    async name => {
      const { agent: _agent, ...toolbox } = toolboxRegistration().toolbox;
      const registration = {
        ...toolboxRegistration(),
        entry: join(homedir(), '.agents', 'skills', name, 'scripts', 'main.mjs'),
        toolbox,
      };
      const dependencies = { findRegistration: () => registration, listPlugins: () => ['tool'] };
      const skillUpdate = { name, scope: 'global' };
      expect((await listToolboxPluginTools(dependencies)).tools[0]).toHaveProperty(
        'skillUpdate',
        skillUpdate,
      );
      const opened = await openToolboxPluginTool('plugin:tool', { invoke: vi.fn() }, dependencies);
      expect(opened).toHaveProperty('skillUpdate', skillUpdate);
      expect(opened).not.toHaveProperty('agent');
    },
  );

  it('uses the setup uninstaller for a registered toolbox plugin', async () => {
    const uninstallPlugin = vi
      .fn()
      .mockResolvedValue({ removed: true, unregisteredNames: ['notebook'] });
    await expect(
      uninstallToolboxPlugin('plugin:notebook', {
        findRegistration: () => toolboxRegistration(),
        uninstallPlugin,
      }),
    ).resolves.toEqual({ plugin: 'notebook', removed: true });
    expect(uninstallPlugin).toHaveBeenCalledWith('notebook', expect.any(Function));
    await expect(
      uninstallToolboxPlugin('plugin:missing', {
        findRegistration: () => undefined,
        uninstallPlugin,
      }),
    ).rejects.toThrow('Tool is not registered');
    expect(uninstallPlugin).toHaveBeenCalledTimes(1);
  });

  it('keeps the registered tool usable when its Skill is disabled and restored', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-toolbox-skill-'));
    const entry = join(directory, 'scripts', 'main.mjs');
    mkdirSync(join(directory, 'scripts'));
    writeFileSync(join(directory, 'SKILL.md'), '# Skill');
    const dependencies = {
      listPlugins: () => ['notebook'],
      findRegistration: () => ({ ...toolboxRegistration(), entry }),
      invokePlugin: vi.fn().mockResolvedValue(['result']),
    };
    try {
      expect((await listToolboxPluginTools(dependencies)).tools[0].skillEnabled).toBe(true);
      expect(setToolboxSkillEnabled('plugin:notebook', false, dependencies)).toEqual({
        enabled: false,
      });
      expect(existsSync(join(directory, 'SKILL.md'))).toBe(false);
      expect((await listToolboxPluginTools(dependencies)).tools[0].skillEnabled).toBe(false);
      await expect(
        openToolboxPluginTool('plugin:notebook', { invoke: vi.fn() }, dependencies),
      ).resolves.toHaveProperty('page.hash', hash);
      await expect(
        invokeToolboxPluginTool('plugin:notebook', 'list', {}, { invoke: vi.fn() }, dependencies),
      ).resolves.toEqual({ result: ['result'] });
      expect(setToolboxSkillEnabled('plugin:notebook', true, dependencies)).toEqual({
        enabled: true,
      });
      expect(existsSync(join(directory, 'SKILL.md'))).toBe(true);
      expect(() => setToolboxSkillEnabled('plugin:notebook', 'false', dependencies)).toThrow(
        'boolean',
      );
      expect(() => setToolboxSkillEnabled('plugin:../notebook', false, dependencies)).toThrow(
        'invalid',
      );
      expect(() =>
        setToolboxSkillEnabled('plugin:missing', false, { findRegistration: () => undefined }),
      ).toThrow('not registered');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the drawer layout when an Agent tool does not declare a layout', async () => {
    const registration = toolboxRegistration();
    await expect(
      openToolboxPluginTool(
        'plugin:notebook',
        { invoke: vi.fn() },
        {
          findRegistration: () => ({
            ...registration,
            toolbox: {
              ...registration.toolbox,
              agent: { skill: 'notebook-skill' },
            },
          }),
        },
      ),
    ).resolves.toMatchObject({ agent: { enabled: true, layout: 'drawer' } });
  });

  it('resolves the installed Skill preferred by the registered Agent panel', () => {
    expect(
      resolveToolboxPluginAgent('plugin:notebook', {
        findRegistration: () => toolboxRegistration(),
      }),
    ).toEqual({
      toolId: 'plugin:notebook',
      skill: 'notebook-skill',
    });
    expect(() =>
      resolveToolboxPluginAgent('plugin:missing', { findRegistration: () => undefined }),
    ).toThrow('Tool Agent is not registered');
  });

  it('reads exact page chunks through the registered plugin identity', () => {
    const readPageChunk = vi.fn().mockReturnValue({
      data: 'PGh0bWw+',
      hash,
      index: 1,
      total: 2,
    });
    expect(readToolboxPluginPageChunk('plugin:notebook', hash, 1, { readPageChunk })).toEqual({
      data: 'PGh0bWw+',
      hash,
      index: 1,
      total: 2,
    });
    expect(readPageChunk).toHaveBeenCalledWith('notebook', hash, 1);
  });

  it('invokes only commands declared by the sandbox page', async () => {
    const invokePlugin = vi.fn().mockResolvedValue({ items: [{ id: 'notebook-1' }] });
    const context = { invoke: vi.fn() };
    const dependencies = {
      findRegistration: () => toolboxRegistration(),
      invokePlugin,
    };

    await expect(
      invokeToolboxPluginTool('plugin:notebook', 'list', {}, context, dependencies),
    ).resolves.toEqual({ result: { items: [{ id: 'notebook-1' }] } });
    expect(invokePlugin).toHaveBeenCalledWith('notebook', { command: 'list', input: {} }, context);
    await expect(
      invokeToolboxPluginTool('plugin:notebook', 'write', {}, context, dependencies),
    ).rejects.toThrow('Tool command is not allowed');
  });

  it('delegates background execution to a scoped persistent task client', async () => {
    const taskId = 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222';
    const task = { taskId, state: 'success', result: { bytes: 10, sha256: hash, chunks: 1 } };
    const client = {
      start: vi.fn().mockResolvedValue({ taskId, state: 'queued' }),
      get: vi.fn().mockResolvedValue(task),
      list: vi.fn().mockResolvedValue({ tasks: [task] }),
      events: vi.fn().mockResolvedValue({ task, nextCursor: 3 }),
      disconnect: vi.fn(),
    };
    const dependencies = {
      findRegistration: () => toolboxRegistration(['publish-all']),
      taskClient: vi.fn().mockReturnValue(client),
    };
    const context = { invoke: vi.fn() };
    await expect(
      handleToolboxTask(
        {
          id: 'plugin:notebook',
          operation: 'start',
          command: 'publish-all',
          input: { notebookId: 'one' },
          executionTimeoutMs: 5000,
          idempotencyKey: 'publish-one',
        },
        context,
        dependencies,
      ),
    ).resolves.toEqual({ taskId, state: 'queued' });
    expect(dependencies.taskClient).toHaveBeenCalledWith('notebook', context);
    expect(client.start).toHaveBeenCalledWith(
      'notebook',
      { command: 'publish-all', input: { notebookId: 'one' } },
      { executionTimeoutMs: 5000, idempotencyKey: 'publish-one' },
    );
    await vi.waitFor(() => expect(client.disconnect).toHaveBeenCalled());
    await expect(
      handleToolboxTask(
        { id: 'plugin:notebook', operation: 'start', command: 'hidden-command' },
        context,
        dependencies,
      ),
    ).rejects.toThrow();
  });

  it.each([
    { request: { operation: 'get', taskId: 'task' }, method: 'get', args: ['task'] },
    { request: { operation: 'cancel', taskId: 'task' }, method: 'cancel', args: ['task'] },
    {
      request: { operation: 'list', activeOnly: false, cursor: 'next', limit: 20 },
      method: 'list',
      args: [false, { cursor: 'next', limit: 20 }],
    },
    {
      request: { operation: 'events', taskId: 'task', cursor: 3, waitMs: 10000 },
      method: 'events',
      args: ['task', 3, 10000],
    },
    { request: { operation: 'events', taskId: 'task' }, method: 'events', args: ['task', 0, 0] },
    {
      request: { operation: 'result', taskId: 'task', index: 2 },
      method: 'resultChunk',
      args: ['task', 2],
    },
    {
      request: { operation: 'diagnose', includeLocalPaths: false },
      method: 'diagnose',
      args: [{ includeLocalPaths: false }],
    },
  ] as const)(
    'routes task $request.operation through the owning plugin query client',
    async ({ request, method, args }) => {
      const client = {
        get: vi.fn().mockResolvedValue({ forwarded: true }),
        cancel: vi.fn().mockResolvedValue({ forwarded: true }),
        list: vi.fn().mockResolvedValue({ forwarded: true }),
        events: vi.fn().mockResolvedValue({ forwarded: true }),
        resultChunk: vi.fn().mockResolvedValue({ forwarded: true }),
        diagnose: vi.fn().mockResolvedValue({ forwarded: true }),
      };
      const dependencies = { taskClient: vi.fn().mockReturnValue(client) };
      await expect(
        handleToolboxTask(
          { ...request, id: 'plugin:notebook' },
          { invoke: vi.fn() },
          dependencies,
        ),
      ).resolves.toEqual({ forwarded: true });
      expect(dependencies.taskClient).toHaveBeenCalledWith('notebook', undefined);
      expect(client[method]).toHaveBeenCalledWith(...args);
    },
  );

  it('rejects unknown task operations and diagnostic scope injection before querying', async () => {
    const dependencies = { taskClient: vi.fn() };
    const context = { invoke: vi.fn() };
    await expect(
      handleToolboxTask(
        { id: 'plugin:notebook', operation: 'unknown' } as never,
        context,
        dependencies,
      ),
    ).rejects.toThrow('Invalid toolbox task operation');
    await expect(
      handleToolboxTask(
        { id: 'plugin:notebook', operation: 'diagnose', plugin: 'other' } as never,
        context,
        dependencies,
      ),
    ).rejects.toThrow('Invalid diagnostic options');
    expect(dependencies.taskClient).not.toHaveBeenCalled();
  });

  it('rejects missing tools, invalid chunks, and oversized command input', async () => {
    const context = { invoke: vi.fn() };
    await expect(
      openToolboxPluginTool('plugin:missing', context, {
        findRegistration: () => undefined,
      }),
    ).rejects.toThrow('Tool is not registered');
    expect(() => readToolboxPluginPageChunk('plugin:notebook', 'bad-hash', 0)).toThrow(
      'hash is invalid',
    );
    await expect(
      invokeToolboxPluginTool(
        'plugin:notebook',
        'list',
        { value: 'x'.repeat(300 * 1024) },
        context,
        { findRegistration: () => toolboxRegistration(), invokePlugin: vi.fn() },
      ),
    ).rejects.toThrow('Tool input is too large');
  });
});
