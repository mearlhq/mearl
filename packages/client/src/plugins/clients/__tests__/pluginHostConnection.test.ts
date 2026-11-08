import { createServer } from 'node:net';
import { CLIENT_VERSION } from '../../../runtimePaths.js';
import { PLUGIN_TASK_PROTOCOL_VERSION } from '@mearl/browser-core';
import { readPluginTaskMessages, writePluginTaskMessage } from '../../pluginTaskWire.js';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginHostConnection } from '../pluginHostConnection.js';
import { PluginModelClient } from '../pluginModels.js';
import { PluginStateClient } from '../pluginState.js';
import { PluginTaskClient } from '../pluginTasks.js';
import { PluginPageClient } from '../pluginPages.js';
import { findPluginRegistration, registerPlugin } from '../../pluginRegistry.js';
import { startPluginHostServer } from '../../runtime/pluginHostServer.js';

let directory: string;
let service: Awaited<ReturnType<typeof startPluginHostServer>>;
const connections: PluginHostConnection[] = [];
const stateStorage = {
  version: 1,
  collections: {
    settings: {
      scope: 'installation',
      storage: 'persistent',
      schemaVersion: 1,
      schema: { type: 'integer' },
    },
  },
};
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-host-connection-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  const root = join(directory, 'skill');
  mkdirSync(root);
  writeFileSync(join(root, 'SKILL.md'), '# Fixture');
  writeFileSync(
    join(root, 'main.mjs'),
    'export default app => app.command("echo", input => input);',
  );
  registerPlugin('fixture', join(root, 'main.mjs'));
  registerPlugin('other', join(root, 'main.mjs'));
  service = await startPluginHostServer({
    execute: async (_plugin, invocation, _context, options) =>
      options?.describe ? { stateStorage } : invocation.input,
  });
});
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.disconnect();
  await service.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function connect() {
  const connection = new PluginHostConnection({
    plugin: 'fixture',
    access: 'toolbox',
    source: 'toolbox',
    invoke: vi.fn(),
    autoStart: false,
    socketPath: service.socketPath,
  });
  connections.push(connection);
  return connection;
}

it('shares transport across services without transferring connection ownership or widening plugin scope', async () => {
  const connection = connect(),
    disconnect = vi.spyOn(connection, 'disconnect');
  const models = new PluginModelClient({ connection }),
    state = new PluginStateClient({ connection }),
    tasks = new PluginTaskClient({ connection }),
    pages = new PluginPageClient({}, connection);
  const [capabilities, saved] = await Promise.all([
    models.capabilities(),
    state.get('fixture', 'settings', 'value'),
  ]);
  expect(capabilities.providers[0].provider).toBe('codex');
  expect(saved.exists).toBe(false);
  await expect(state.get('other', 'settings', 'value')).rejects.toThrow('scope');
  await expect(tasks.start('other', { command: 'echo', input: {} })).rejects.toThrow();
  expect((await pages.list('fixture')).instances).toEqual([]);
  models.disconnect();
  state.disconnect();
  tasks.disconnect();
  pages.disconnect();
  expect(disconnect).not.toHaveBeenCalled();
  expect((await models.capabilities()).providers[0].provider).toBe('codex');
  connection.disconnect();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('rejects an in-flight request when its owning connection is disconnected', async () => {
  const connection = connect(),
    models = new PluginModelClient({ connection });
  let release!: (value: any) => void;
  const discover = vi.spyOn(service.host.models, 'list').mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const pending = models.list(),
    rejected = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_TASK_CONNECTION_LOST' });
  await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
  connection.disconnect();
  await rejected;
  release({ provider: 'codex', models: [] });
});

it('closes all sibling services exactly once and rejects new work after host shutdown', async () => {
  const host = service.host;
  const closed = [host.tasks, host.pages, host.state, host.models, host.modelSessions].map(part =>
    vi.spyOn(part, 'close'),
  );
  const first = host.close();
  expect(host.close()).toBe(first);
  await first;
  for (const close of closed) expect(close).toHaveBeenCalledOnce();
  expect(() => host.models.list()).toThrow();
  await expect(
    host.state.call(
      'fixture',
      {},
      {
        id: 'test',
        scope: { access: 'public', source: 'sdk', bridge: 'service' },
        invoke: vi.fn(),
      },
    ),
  ).rejects.toBeDefined();
  expect(() =>
    host.tasks.start(
      {
        plugin: 'fixture',
        command: 'echo',
        input: {},
        options: {},
        environment: {},
        cwd: directory,
      },
      {
        id: 'test',
        scope: { access: 'public', source: 'sdk', bridge: 'service' },
        invoke: vi.fn(),
      },
    ),
  ).toThrow('stopping');
});

it.each([
  {},
  { version: CLIENT_VERSION, buildId: 'previous-build-of-the-same-version' },
  { version: '0.0.1', buildId: 'current-build' },
])('allows compatible services with different or missing build metadata: %j', async identity => {
  const methods: string[] = [];
  const server = createServer(socket => {
    readPluginTaskMessages(socket, message => {
      if (message.type !== 'request') return;
      methods.push(message.method);
      void writePluginTaskMessage(socket, {
        type: 'response',
        id: message.id,
        result:
          message.method === 'hello' || message.method === 'status'
            ? {
                protocolVersion: PLUGIN_TASK_PROTOCOL_VERSION,
                host: service.host.tasks.host,
                pid: process.pid,
                ...identity,
              }
            : { tasks: [{ taskId: 'running-task', state: 'running' }] },
      });
    });
  });
  const socketPath = join(directory, 'outdated.sock');
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const connection = new PluginHostConnection({ autoStart: false, socketPath });
  connections.push(connection);
  try {
    const state = new PluginStateClient({ connection });
    const models = new PluginModelClient({ connection });
    await expect(state.get('fixture', 'settings', 'key')).resolves.toBeDefined();
    await expect(models.list()).resolves.toBeDefined();
    await expect(connection.request('start', { plugin: 'fixture' })).resolves.toBeDefined();
    await expect(connection.request('page.call', { plugin: 'fixture' })).resolves.toBeDefined();
    expect((await connection.request('list')).tasks[0].state).toBe('running');
    expect((await connection.request('status')).pid).toBe(process.pid);
    expect(methods).toEqual([
      'hello',
      'state.call',
      'model.list',
      'start',
      'page.call',
      'list',
      'status',
    ]);
  } finally {
    connection.disconnect();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
});

it('reports invalid metadata through state access and preserves its validation cause locally', async () => {
  const file = join(directory, 'registry', 'fixture.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.toolbox = { version: 1, title: 'Feedback', icon: 'javascript:secret-value' };
  writeFileSync(file, JSON.stringify(record));
  let failure: any;
  try {
    findPluginRegistration('fixture');
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'PLUGIN_REGISTRY_INVALID', cause: expect.any(Error) });
  expect(failure.message).toContain('toolbox.icon');
  expect(failure.message).not.toContain('secret-value');
  const state = new PluginStateClient({ connection: connect() });
  await expect(state.get('fixture', 'settings', 'key')).rejects.toThrow('toolbox.icon');
});

it('rejects a different protocol before dispatching business requests', async () => {
  const methods: string[] = [];
  const server = createServer(socket => {
    readPluginTaskMessages(socket, message => {
      if (message.type !== 'request') return;
      methods.push(message.method);
      void writePluginTaskMessage(socket, {
        type: 'response',
        id: message.id,
        result: {
          protocolVersion: PLUGIN_TASK_PROTOCOL_VERSION + 1,
          host: service.host.tasks.host,
          pid: process.pid,
        },
      });
    });
  });
  const socketPath = join(directory, 'incompatible.sock');
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const connection = new PluginHostConnection({ autoStart: false, socketPath });
  connections.push(connection);
  try {
    await expect(connection.request('start', { plugin: 'fixture' })).rejects.toThrow(
      'protocol version mismatch',
    );
    expect(methods).toEqual(['hello']);
  } finally {
    connection.disconnect();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
});

it('does not expose malformed JSON content in registry diagnostics', () => {
  writeFileSync(join(directory, 'registry', 'fixture.json'), '{"secret":"private-value", broken');
  expect(() => findPluginRegistration('fixture')).toThrow('JSON 格式错误');
  try {
    findPluginRegistration('fixture');
  } catch (error) {
    expect((error as Error).message).not.toContain('private-value');
  }
});
