import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativePresetAutoUpdater } from '../preset-auto-update.js';
import { PRESET_UPDATE_INTERVAL_MS, PRESET_UPDATE_RETRY_MS } from '@mearl/preset/installation';
import { NodeCapabilityRegistry } from '@mearl/daemon-core/capabilities';
import { bundleDigest, PRESET_TRANSFER_CHUNK_BYTES } from '@mearl/preset/bundles';
import {
  PresetInstaller,
  PresetInstallationStore,
  PresetUninstallBlockedError,
} from '@mearl/setup/preset';
import {
  NativePresetInstallation,
  createInstallationResourceLoader,
} from '../preset-installation.js';
let directory: string;
const source = 'https://assets.example.test/presets/team.json';
const session = '12345678-1234-1234-1234-123456789abc';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mearl-native-installation-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function fixture(withSkill = false) {
  const code = new TextEncoder().encode(
    `module.exports=(host,config)=>{host.started();return {value:()=>config.manager??'default'}};/*${'x'.repeat(PRESET_TRANSFER_CHUNK_BYTES + 17)}*/`,
  );
  const resources = new Map<string, Uint8Array>([
    [
      source,
      encode({
        schemaVersion: 1,
        id: 'team',
        version: '1.0.0',
        packages: { sample: { source: '../sample/bundle.json', targets: ['node'] } },
        defaults: { capabilities: { sample: { manager: 'initial' } } },
        ...(withSkill ? { skills: { helper: { source: 'example/skills' } } } : {}),
      }),
    ],
    ['https://assets.example.test/sample/runtime.cjs', code],
    [
      'https://assets.example.test/sample/bundle.json',
      encode({
        schemaVersion: 1,
        id: 'sample',
        version: '1.0.0',
        resources: {
          'runtime.cjs': { sha256: await bundleDigest(code), byteLength: code.byteLength },
        },
        contributions: {
          appProfiles: [],
          nodeRuntimes: {
            'native-host': { entry: 'runtime.cjs', bindings: { 'example.value': 'value' } },
          },
        },
      }),
    ],
  ]);
  const started = vi.fn();
  const registry = new NodeCapabilityRegistry({ started }, directory);
  let componentsReady = false;
  const request = vi.fn(async input => {
    if (input.operation === 'confirm') return { confirmed: true };
    if (input.operation !== 'resource' || input.session !== session)
      throw new Error('unexpected resource session');
    const bytes = resources.get(input.source)!;
    return {
      sha256: await bundleDigest(bytes),
      byteLength: bytes.byteLength,
      data: Buffer.from(
        bytes.subarray(input.offset, input.offset + PRESET_TRANSFER_CHUNK_BYTES),
      ).toString('base64'),
    };
  });
  const invoke = vi.fn(async (action, data) => {
    if (action === 'node_capabilities_reload') {
      await registry.refresh();
      return {
        revision: registry.revision,
        installationRevision: registry.installationRevision,
        accepted: true,
      };
    }
    if (action === 'node_capabilities_status')
      return { revision: registry.revision, installationRevision: registry.installationRevision };
    if (action === 'preset_components_install') componentsReady = true;
    if (action.startsWith('preset_components_')) {
      const current = await new PresetInstallationStore({ directory }).current();
      return {
        installationRevision: data.installationRevision,
        nodeRevision: current.receipt!.nodeRevision,
        components: [
          { kind: 'skills', id: 'helper', state: componentsReady ? 'ready' : 'pending' },
        ],
      };
    }
    throw new Error('Unexpected service ' + action);
  });
  const service = new NativePresetInstallation({ directory, request, invoke });
  const apply = (extra: Record<string, unknown> = {}) =>
    service.handle({
      operation: 'apply',
      session,
      source,
      presetId: 'team',
      expectedRevision: null,
      ...extra,
    });
  return { service, request, invoke, resources, started, registry, apply };
}
it('inspects without effects, receives exact chunks, activates the existing registry and checks actual state', async () => {
  const f = await fixture();
  expect(await f.service.handle({ operation: 'inspect' })).toMatchObject({
    protocol: 1,
    selection: null,
  });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
  const result = (await f.apply()) as any;
  expect(result).toMatchObject({ id: 'team', ready: true, browserSyncRequired: false });
  expect(f.started).toHaveBeenCalledOnce();
  expect(f.registry.get('example.value')!()).toBe('initial');
  expect(f.request.mock.calls.some(([input]) => input.offset === PRESET_TRANSFER_CHUNK_BYTES)).toBe(
    true,
  );
  const resourceCalls = f.request.mock.calls.filter(([input]) => input.operation === 'resource');
  expect(resourceCalls.every(([input]) => input.session === session)).toBe(true);
  expect(
    await f.service.handle({
      operation: 'status',
      expectedRevision: result.revision,
      presetId: 'team',
      source,
    }),
  ).toMatchObject({ ready: true });
  expect(
    await f.service.handle({
      operation: 'status',
      expectedRevision: result.revision,
      presetId: 'other',
      source,
    }),
  ).toEqual({ ready: false, changed: true });
});
it('preserves explicit user overrides and refuses stale native selections before downloading', async () => {
  const f = await fixture();
  const initial = (await f.apply()) as any;
  const store = new PresetInstallationStore({ directory });
  const current = await store.current();
  const accepted = await store.apply(current.prepared!, {
    expectedRevision: initial.revision,
    overrides: { capabilities: { sample: { manager: 'custom' } } },
  });
  f.request.mockClear();
  await expect(f.apply({ expectedRevision: initial.revision })).rejects.toThrow(
    'changed before preparation',
  );
  expect(f.request).not.toHaveBeenCalled();
  const result = (await f.apply({ expectedRevision: accepted.revision })) as any;
  expect(result.ready).toBe(true);
  expect(f.registry.get('example.value')!()).toBe('custom');
  expect((await store.current()).receipt!.overrides).toEqual(accepted.overrides);
});
it('passes explicit Skill replacement only through a confirmed resume of the same installation', async () => {
  const f = await fixture(true);
  const original = f.invoke.getMockImplementation()!;
  let replaced = false;
  f.invoke.mockImplementation(async (action, data) => {
    if (action === 'preset_components_install') {
      if (!data.replaceSkills) throw new Error('SKILL_SOURCE_CONFLICT: helper');
      expect(data.replaceSkills).toEqual(['helper']);
      replaced = true;
    }
    if (action.startsWith('preset_components_')) {
      const current = await new PresetInstallationStore({ directory }).current();
      return {
        installationRevision: current.receipt!.revision,
        nodeRevision: current.receipt!.nodeRevision,
        components: [
          {
            kind: 'skills',
            id: 'helper',
            state: replaced ? 'ready' : 'conflict',
            ...(!replaced ? { reason: 'SKILL_SOURCE_CONFLICT' } : {}),
          },
        ],
      };
    }
    return original(action, data);
  });
  await expect(f.apply({ replaceSkills: ['helper'] })).rejects.toThrow(
    'INVALID_PRESET_INSTALLATION_REQUEST',
  );
  const initial = (await f.apply()) as any;
  expect(initial).toMatchObject({
    ready: false,
    pending: [{ id: 'helper', reason: 'SKILL_SOURCE_CONFLICT' }],
  });
  f.request.mockClear();
  const result = await f.service.handle({
    operation: 'resume',
    session,
    source,
    presetId: 'team',
    expectedRevision: initial.revision,
    replaceSkills: ['helper'],
  });
  expect(result).toMatchObject({ ready: true });
  expect(f.request).toHaveBeenCalledWith({ operation: 'confirm', session }, 15000);
  expect(f.request.mock.calls.some(([input]) => input.operation === 'resource')).toBe(false);
});
it('checks preset identity and final browser confirmation before writing the Node pointer', async () => {
  const f = await fixture();
  await expect(f.apply({ presetId: 'different' })).rejects.toThrow('identity');
  expect((await new PresetInstallationStore({ directory }).current()).receipt).toBeUndefined();
  const request = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => {
    if (input.operation === 'confirm') throw new Error('INSTALLATION_PERMISSION_CHANGED');
    return request(input);
  });
  await expect(f.apply()).rejects.toThrow('PERMISSION_CHANGED');
  expect(f.started).not.toHaveBeenCalled();
  expect((await new PresetInstallationStore({ directory }).current()).receipt).toBeUndefined();
});
it('never interprets browser-supplied shell arguments or additional install options', async () => {
  const f = await fixture();
  await expect(f.apply({ command: 'exec' })).rejects.toThrow('INVALID_PRESET_INSTALLATION_REQUEST');
  for (const url of [
    'file:///tmp/preset.json',
    'http://assets.example.test/preset.json',
    'https://user:secret@assets.example.test/team.json',
  ])
    await expect(f.apply({ source: url })).rejects.toThrow('SOURCE');
  expect(f.request).not.toHaveBeenCalled();
});
it('only delegates removal with the confirmed installer revision', async () => {
  const f = await fixture();
  const remove = vi.spyOn(PresetInstaller.prototype, 'uninstall').mockResolvedValue({
    revision: null,
    ready: true,
    hosts: [],
    browsers: [],
    pending: [],
    warnings: [],
  });
  try {
    await expect(f.service.handle({ operation: 'uninstall' })).rejects.toThrow(
      'INVALID_PRESET_INSTALLATION_REQUEST',
    );
    expect(remove).not.toHaveBeenCalled();
    const revision = 'a'.repeat(64);
    expect(
      await f.service.handle({ operation: 'uninstall', expectedRevision: revision }),
    ).toMatchObject({ ready: true });
    expect(remove).toHaveBeenCalledExactlyOnceWith(revision);
    const blocker = { reason: 'browser-update-required', browser: 'Example Browser' } as const;
    remove.mockRejectedValueOnce(new PresetUninstallBlockedError(blocker, 'Update required'));
    expect(await f.service.handle({ operation: 'uninstall', expectedRevision: revision })).toEqual({
      ready: false,
      blocker,
    });
  } finally {
    remove.mockRestore();
  }
});
it('checks chunk digests and exact lengths before accepting a browser resource', async () => {
  const bytes = new TextEncoder().encode('valid');
  const request = vi.fn(async () => ({
    sha256: await bundleDigest(bytes),
    byteLength: bytes.byteLength,
    data: Buffer.from('invalid').toString('base64'),
  }));
  const load = createInstallationResourceLoader(session, request);
  await expect(load(source, { maxBytes: 100 })).rejects.toThrow('chunk');
  await expect(load(source, { maxBytes: 1 })).rejects.toThrow('RESPONSE');
  await expect(load(source, { maxBytes: 99_000_000 })).rejects.toThrow('LIMIT');
});

describe('headless trusted preset updates', () => {
  async function automatic() {
    const f = await fixture();
    const initial = (await f.apply()) as any;
    let now = 1000;
    const configuration = vi.fn(async () => ({
      schemaVersion: 1 as const,
      presets: { team: { label: 'Team', source, origins: ['https://*.example.test/*'] } },
    }));
    const load = vi.fn(async (url: string) => {
      const bytes = f.resources.get(url);
      if (!bytes) throw new Error('offline');
      return bytes;
    });
    const dependencies = {
      directory,
      invoke: f.invoke as any,
      extensionConnected: () => false,
      configuration,
      load,
      now: () => now,
    };
    const update = createNativePresetAutoUpdater(dependencies);
    const change = (extra: Record<string, unknown> = {}) => {
      const manifest = JSON.parse(new TextDecoder().decode(f.resources.get(source)));
      f.resources.set(
        source,
        encode({
          ...manifest,
          version: '1.0.1',
          defaults: { capabilities: { sample: { manager: 'updated' } } },
          ...extra,
        }),
      );
    };
    f.started.mockClear();
    return {
      ...f,
      initial,
      update,
      change,
      dependencies,
      load,
      configuration,
      advance: (ms: number) => {
        now += ms;
      },
      state: async () => JSON.parse(await readFile(join(directory, 'auto-update.json'), 'utf8')),
    };
  }
  it('updates the selected source, throttles process restarts and keeps unchanged factories running', async () => {
    const f = await automatic();
    f.change();
    await f.update();
    expect(f.registry.get('example.value')!()).toBe('updated');
    expect(f.started).toHaveBeenCalledOnce();
    expect(await f.state()).toMatchObject({
      status: 'updated',
      nextCheckAt: 1000 + PRESET_UPDATE_INTERVAL_MS,
    });
    f.load.mockClear();
    await createNativePresetAutoUpdater(f.dependencies)();
    expect(f.load).not.toHaveBeenCalled();
    f.advance(PRESET_UPDATE_INTERVAL_MS);
    f.started.mockClear();
    await f.update();
    expect((await f.state()).status).toBe('current');
    expect(f.started).not.toHaveBeenCalled();
  });
  it('retains the old selection on offline or corrupt resources and retries later', async () => {
    const f = await automatic();
    f.change();
    f.load.mockRejectedValueOnce(new Error('offline'));
    await f.update();
    expect(await f.state()).toMatchObject({ status: 'failed', error: 'offline' });
    expect((await new PresetInstallationStore({ directory }).current()).receipt!.revision).toBe(
      f.initial.revision,
    );
    expect(f.started).not.toHaveBeenCalled();
    f.advance(PRESET_UPDATE_RETRY_MS);
    await f.update();
    expect(f.registry.get('example.value')!()).toBe('updated');
  });
  it('does not trust a matching ID whose catalog source changed, or race the attached browser updater', async () => {
    const f = await automatic();
    f.change();
    f.configuration.mockResolvedValue({
      schemaVersion: 1,
      presets: {
        team: { label: 'Team', source: source + '?other', origins: ['https://*.example.test/*'] },
      },
    });
    await f.update();
    expect((await f.state()).status).toBe('untrusted');
    expect(f.load).not.toHaveBeenCalled();
    await createNativePresetAutoUpdater({ ...f.dependencies, extensionConnected: () => true })();
    expect(f.started).not.toHaveBeenCalled();
  });
  it('defers permission expansion and rejects graph resources outside the trusted catalog', async () => {
    const f = await automatic();
    f.change({ permissions: { origins: ['https://new.example.test/*'] } });
    await f.update();
    expect((await f.state()).error).toBe('PRESET_UPDATE_PERMISSION_REQUIRED');
    expect((await new PresetInstallationStore({ directory }).current()).receipt!.revision).toBe(
      f.initial.revision,
    );
    f.advance(PRESET_UPDATE_RETRY_MS);
    f.change({
      packages: { sample: { source: 'https://attacker.test/bundle.json', targets: ['node'] } },
    });
    await f.update();
    expect((await f.state()).error).toBe('PRESET_UPDATE_SOURCE_DENIED');
    expect(
      f.load.mock.calls.every(([url]) => new URL(url).hostname.endsWith('.example.test')),
    ).toBe(true);
    expect(f.started).not.toHaveBeenCalled();
  });
});

it('checks automatic browser-grant approval before the Node pointer or factory changes', async () => {
  const f = await fixture();
  const initial = (await f.apply()) as any;
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => {
    if (input.operation === 'permissions') throw new Error('INSTALLATION_PERMISSION_REQUIRED');
    return original(input);
  });
  f.started.mockClear();
  const manifest = JSON.parse(new TextDecoder().decode(f.resources.get(source)));
  f.resources.set(source, encode({ ...manifest, version: '1.0.1' }));
  await expect(
    f.service.handle({
      operation: 'update',
      session,
      source,
      presetId: 'team',
      expectedRevision: initial.revision,
    }),
  ).rejects.toThrow('PERMISSION_REQUIRED');
  expect((await new PresetInstallationStore({ directory }).current()).receipt!.revision).toBe(
    initial.revision,
  );
  expect(f.started).not.toHaveBeenCalled();
});

it('keeps a distinct Node-only preset updating beside an independently selected browser preset', async () => {
  const f = await fixture();
  await f.apply();
  const manifest = JSON.parse(new TextDecoder().decode(f.resources.get(source)));
  f.resources.set(
    source,
    encode({
      ...manifest,
      version: '1.0.1',
      defaults: { capabilities: { sample: { manager: 'independent' } } },
    }),
  );
  f.invoke.mockClear();
  const update = createNativePresetAutoUpdater({
    directory,
    invoke: f.invoke as any,
    extensionConnected: () => true,
    browserSelection: async () => ({
      presetId: 'browser-only',
      presetSource: 'https://different.example.test/preset.json',
    }),
    configuration: async () => ({
      schemaVersion: 1,
      presets: { team: { label: 'Team', source, origins: ['https://*.example.test/*'] } },
    }),
    load: async url => f.resources.get(url)!,
  });
  await update();
  expect(f.registry.get('example.value')!()).toBe('independent');
  expect(f.invoke.mock.calls.some(([action]) => action === 'preset_browser_sync')).toBe(false);
});
