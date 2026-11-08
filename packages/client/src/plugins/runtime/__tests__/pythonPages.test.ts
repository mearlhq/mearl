import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPlugin } from '../../sdk/plugin.js';
import { createPluginInvocationIdentity } from '../pluginExecution.js';

let directory: string, entry: string;
const source = `pageRuntime = {"version":1,"matches":["https://example.test/*"],"code":"host => ({receive: message => message})","events":{"changed":{"command":"save","schema":{"type":"object"}},"shared":{"command":"shared","schema":{"type":"object"}}}}
def register(app):
    app.command("open", lambda input, context: app.page("attach", input))
    @app.runtimeCommand("save", description="Save event")
    def save(input, context):
        return {"before":context.page.get(),"after":context.page.send(input["event"]["payload"])}
    app.command("shared", lambda input, context: {"public":True,"bound":context.page is not None})
`;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-python-pages-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  mkdirSync(join(directory, 'scripts'));
  entry = join(directory, 'scripts/main.py');
  writeFileSync(entry, source);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('Python page declarations and execution', () => {
  it('supports streaming model callbacks that call page services while the model response arrives', async () => {
    writeFileSync(
      entry,
      `def register(app):
    @app.command("ask")
    def ask(input, context):
        seen = []
        def preview(progress):
            seen.append(context.invoke("preview", progress))
        result = context.model({"provider":"codex","mode":"agent","permissions":"read-only","prompt":"translate"}, on_progress=preview)
        return {"result":result,"seen":seen}
`,
    );
    const delta = { message: 'model.delta', data: { index: 1, delta: '译文' } };
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const invoke = vi.fn(async () => {
      await gate;
      return 'rendered';
    });
    const plugin = await loadPlugin(
      entry,
      {
        options: {},
        progress: vi.fn(),
        invoke,
        runModel: async (_plugin, _request, options) => {
          options.onProgress?.(delta);
          // The final model response precedes the nested page reply on the same pipe.
          setTimeout(release, 10);
          return { text: 'final', provider: 'codex', mode: 'agent' };
        },
      },
      'python-page',
    );
    await expect(plugin.run(['ask'])).resolves.toEqual({
      result: { text: 'final', provider: 'codex', mode: 'agent' },
      seen: ['rendered'],
    });
    expect(invoke).toHaveBeenCalledWith('preview', delta, {});
  });
  it('exposes app.page and keeps runtime-only commands out of public and toolbox calls', async () => {
    const invoke = vi.fn().mockResolvedValue({ instanceId: 'created' });
    const plugin = await loadPlugin(
      entry,
      { options: {}, progress: vi.fn(), invoke },
      'python-page',
    );
    expect(plugin.pageRuntime?.events?.changed.command).toBe('save');
    expect(plugin.commandHelp('mearl python-page')).toContain('open');
    expect(plugin.commandHelp('mearl python-page')).not.toContain('save');
    await expect(plugin.run(['save'])).rejects.toMatchObject({
      code: 'PLUGIN_COMMAND_RUNTIME_ONLY',
    });
    await expect(plugin.runToolbox({ command: 'save', input: {} })).rejects.toMatchObject({
      code: 'PLUGIN_COMMAND_RUNTIME_ONLY',
    });
    await expect(plugin.run([], { command: 'open', input: { tabId: 7 } })).resolves.toEqual({
      instanceId: 'created',
    });
    expect(invoke).toHaveBeenCalledWith('plugin_page', {
      plugin: 'python-page',
      operation: 'attach',
      tabId: 7,
    });
    await expect(plugin.run([], { command: 'shared', input: {} })).resolves.toEqual({
      public: true,
      bound: false,
    });
  });

  it('dispatches the actual Python registration type and binds context.page send/get', async () => {
    const target = {
      browserSessionId: 'browser',
      tabId: 7,
      frameId: 0,
      documentId: 'document',
      url: 'https://example.test/page',
    };
    const invocation = {
      ...createPluginInvocationIdentity('python-page', 'runtime'),
      page: { instanceId: 'bound-instance', target },
    };
    const invoke = vi.fn(async (_action, payload) =>
      payload.operation === 'get' ? { active: true } : { echoed: payload.message },
    );
    const plugin = await loadPlugin(
      entry,
      { options: {}, invocation, progress: vi.fn(), invoke },
      'python-page',
    );
    await expect(
      plugin.runRuntime({ command: 'save', input: { event: { payload: { value: 9 } } } }),
    ).resolves.toEqual({ before: { active: true }, after: { echoed: { value: 9 } } });
    expect(invoke).toHaveBeenNthCalledWith(1, 'plugin_page', {
      plugin: 'python-page',
      operation: 'get',
      instanceId: 'bound-instance',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'plugin_page', {
      plugin: 'python-page',
      operation: 'send',
      instanceId: 'bound-instance',
      message: { value: 9 },
    });
    await expect(plugin.runRuntime({ command: 'shared', input: {} })).resolves.toEqual({
      public: true,
      bound: true,
    });
    await expect(plugin.runRuntime({ command: 'open', input: {} })).rejects.toMatchObject({
      code: 'PLUGIN_COMMAND_NOT_ALLOWED',
    });
  });

  it('forwards per-request timeouts from Python bound pages', async () => {
    const source = (await import('node:fs')).readFileSync(entry, 'utf8');
    writeFileSync(
      entry,
      source.replace(
        'context.page.send(input["event"]["payload"])',
        'context.page.send(input["event"]["payload"], {"timeoutSec": 120})',
      ),
    );
    const invocation = {
      ...createPluginInvocationIdentity('python-page', 'runtime'),
      page: {
        instanceId: 'bound-instance',
        target: {
          browserSessionId: 'browser',
          tabId: 7,
          frameId: 0,
          documentId: 'document',
          url: 'https://example.test/page',
        },
      },
    };
    const invoke = vi.fn(async () => ({}));
    const plugin = await loadPlugin(
      entry,
      { options: {}, invocation, progress: vi.fn(), invoke },
      'python-page',
    );
    await plugin.runRuntime({ command: 'save', input: { event: { payload: { value: 9 } } } });
    expect(invoke).toHaveBeenCalledWith(
      'plugin_page',
      expect.objectContaining({ operation: 'send', timeoutSec: 120 }),
    );
  });
  it.each(['pageRuntime', 'runtimeOnly'])(
    'checks %s again before acknowledging execution',
    async field => {
      const counter = join(directory, 'counter');
      writeFileSync(
        entry,
        `from pathlib import Path
counter=Path(${JSON.stringify(counter)})
count=int(counter.read_text())+1 if counter.exists() else 1
counter.write_text(str(count))
` +
          (field === 'pageRuntime'
            ? source.replace(
                '"https://example.test/*"',
                '"https://example.test/*" if count == 1 else "https://changed.test/*"',
              )
            : source.replace(
                'app.command("shared",',
                '(app.command if count == 1 else app.runtimeCommand)("shared",',
              )),
      );
      const invoke = vi.fn();
      const plugin = await loadPlugin(
        entry,
        { options: {}, progress: vi.fn(), invoke },
        'python-page',
      );
      await expect(plugin.run([], { command: 'open', input: {} })).rejects.toMatchObject({
        code: 'PLUGIN_DECLARATION_CHANGED',
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('requires runtime-only registrations to be declared in pageRuntime', async () => {
    writeFileSync(
      entry,
      'def register(app):\n    app.runtimeCommand("hidden", lambda input: None)\n',
    );
    await expect(
      loadPlugin(entry, { options: {}, progress: vi.fn(), invoke: vi.fn() }, 'python-page'),
    ).rejects.toThrow('runtimeCommand is not declared');
  });
});
