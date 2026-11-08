import { PluginHost } from '../../../client/src/plugins/runtime/pluginHost.js';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PluginPageManager } from '../../../client/src/plugins/runtime/pluginPageManager.js';
import { registerPlugin } from '../../../client/src/plugins/pluginRegistry.js';
import type { PluginTaskBridge } from '../../../client/src/plugins/runtime/pluginTaskManager.js';

let host: PluginHost;
let runtime: string, directory: string;
let pages: PluginPageManager | undefined;
beforeAll(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'mearl-python-page-worker-'));
  writeFileSync(join(runtime, 'package.json'), '{"type":"module","version":"test"}');
  await build({
    entryPoints: [fileURLToPath(new URL('../../../client/src/plugin-worker.ts', import.meta.url))],
    outfile: join(runtime, 'dist/plugin-worker.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import {createRequire as __pythonPageRequire} from "node:module";const require=__pythonPageRequire(import.meta.url);',
    },
  });
});
afterAll(() => rmSync(runtime, { recursive: true, force: true }));
afterEach(async () => {
  await host?.close();
  pages = undefined;
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('supervised Python page runtime', () => {
  it('runs hidden initialization and events against the bound instance and its state', async () => {
    directory = mkdtempSync(join(tmpdir(), 'mearl-python-page-test-'));
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
    const skill = join(directory, 'skill');
    mkdirSync(skill);
    writeFileSync(join(skill, 'SKILL.md'), '# Python page fixture');
    const entry = join(skill, 'main.py');
    writeFileSync(
      entry,
      `pageRuntime={"version":1,"matches":["https://example.test/*"],"code":"host => ({receive:message => message})","initialize":"initialize","events":{"changed":{"command":"save","schema":{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":False}}}}
stateStorage={"version":1,"collections":{"cache":{"scope":"instance","storage":"cache","schemaVersion":1,"schema":{"type":"integer"}}}}
def register(app):
    @app.runtimeCommand("initialize")
    def initialize(input,context):
        return context.page.send({"type":"ready","documentId":context.page.get()["target"]["documentId"]})
    @app.runtimeCommand("save")
    def save(input,context):
        value=input["event"]["payload"]["value"]
        current=context.state("cache","get",{"key":"value"})
        context.state("cache","transact",{"transaction":{"operations":[{"type":"put","key":"value","value":value,"expectedVersion":current["version"]}]}})
        return context.page.send({"type":"saved","value":value})
`,
    );
    registerPlugin('python-page', entry);
    host = new PluginHost({ workerPath: join(runtime, 'dist/plugin-worker.js') });
    pages = host.pages;
    const target = {
      browserSessionId: 'browser',
      tabId: 7,
      frameId: 0,
      documentId: 'document',
      url: 'https://example.test/page',
    };
    const instances = new Map<string, any>(),
      messages: unknown[] = [];
    const bridge: PluginTaskBridge = {
      id: 'python-caller',
      scope: { access: 'public', plugin: 'python-page', source: 'sdk', bridge: 'caller' },
      invoke: vi.fn(async (action, data) => {
        expect(action).toBe('page_runtime');
        if (data.operation === 'resolve') return target;
        if (data.operation === 'session') return { browserSessionId: target.browserSessionId };
        if (data.operation === 'attach') {
          instances.set((data.instance as any).instanceId, data.instance);
          return data.instance;
        }
        if (data.operation === 'detach') {
          instances.delete(String(data.instanceId));
          return {};
        }
        const instance = instances.get(String(data.instanceId));
        if (!instance) throw new Error('Document unavailable');
        if (data.operation === 'get') return instance;
        if (data.operation === 'send') {
          messages.push(data.message);
          return { kind: 'value', value: data.message };
        }
        throw new Error('Unexpected page operation');
      }),
    };
    const instance = await pages.call(
      'python-page',
      { operation: 'attach', tabId: 7, frame: 'main' },
      bridge,
    );
    expect(messages).toEqual([{ type: 'ready', documentId: 'document' }]);
    await pages.receive(
      'python-page',
      { instanceId: instance.instanceId, eventSequence: 1, name: 'changed', payload: { value: 9 } },
      bridge,
    );
    await vi.waitFor(
      async () =>
        expect(
          (
            await pages!.call(
              'python-page',
              { operation: 'events', instanceId: instance.instanceId },
              bridge,
            )
          ).events,
        ).toContainEqual(expect.objectContaining({ type: 'success', name: 'changed' })),
      { timeout: 10000 },
    );
    expect(messages).toEqual([
      { type: 'ready', documentId: 'document' },
      { type: 'saved', value: 9 },
    ]);
    expect(
      await host.state.call(
        'python-page',
        { operation: 'get', collection: 'cache', key: 'value', instanceId: instance.instanceId },
        bridge,
      ),
    ).toMatchObject({ exists: true, value: 9 });
  }, 20000);
});
