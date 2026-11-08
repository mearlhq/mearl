import {
  invokeLocalHost,
  invoke as invokeExistingHost,
  listLiveBrowsers,
  SOCKET_PATH,
} from '@mearl/client/local';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeCapabilityRegistry } from '@mearl/daemon-core/capabilities';
import { prepareCapabilitySnapshot } from '@mearl/preset';
import { bundleDigest, preparePreset } from '@mearl/preset/bundles';
import {
  createNodePresetLoader,
  PresetInstallationStore,
  PresetInstaller,
  presetSelectionRevision,
  resolveInstallationConfigUrl,
  runPresetCommand,
} from '../preset.js';
import { prepareSetupPreset } from '../setupPreset.js';

vi.mock('@mearl/client/local', async importOriginal => ({
  ...(await importOriginal<typeof import('@mearl/client/local')>()),
  listLiveBrowsers: vi.fn(() => []),
  invokeLocalHost: vi.fn(),
  invoke: vi.fn(),
}));

const source = 'https://example.com/presets/team.json';
const base = 'https://example.com/presets/base.json';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
let directory: string;

describe('installation catalog URL', () => {
  it('accepts a deployment override and rejects credential-bearing or insecure trust roots', () => {
    expect(resolveInstallationConfigUrl('https://example.com/catalog.json').href).toBe(
      'https://example.com/catalog.json',
    );
    for (const value of [
      'http://example.com/catalog.json',
      'https://user:secret@example.com/catalog.json',
      'https://example.com/catalog.json#other',
      'file:///tmp/catalog.json',
    ]) {
      expect(() => resolveInstallationConfigUrl(value)).toThrow();
    }
    expect(() => resolveInstallationConfigUrl('http://127.0.0.1:19340/catalog.json')).toThrow();
    expect(resolveInstallationConfigUrl('http://127.0.0.1:19340/catalog.json', true).hostname).toBe(
      '127.0.0.1',
    );
  });
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mearl-preset-install-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function fixture(options: { browser?: boolean; external?: boolean } = {}) {
  const sources = new Map<string, Uint8Array>();
  const setVersion = async (
    version: number,
    code = `module.exports = (host, config) => { host.started(); return { value: () => "v${version}:" + (config.suffix ?? "default") }; }`,
  ) => {
    const resources = { 'runtime.cjs': new TextEncoder().encode(code) };
    const entries = await Promise.all(
      Object.entries(resources).map(async ([name, bytes]) => {
        sources.set(`https://example.com/value/${name}`, bytes);
        return [name, { sha256: await bundleDigest(bytes), byteLength: bytes.byteLength }];
      }),
    );
    sources.set(
      'https://example.com/value/bundle.json',
      encode({
        schemaVersion: 1,
        id: 'value',
        version: `1.0.${version}`,
        resources: Object.fromEntries(entries),
        contributions: {
          appProfiles: [],
          nodeRuntimes: {
            'native-host': { entry: 'runtime.cjs', bindings: { 'sample.value': 'value' } },
          },
        },
      }),
    );
    sources.set(
      base,
      encode({
        schemaVersion: 1,
        id: 'base',
        version: '1.0.0',
        packages: { value: { source: '../value/bundle.json', targets: ['node'] } },
        defaults: { nested: { language: 'en', inherited: true }, array: [1, 2] },
      }),
    );
    sources.set(
      source,
      encode({
        schemaVersion: 1,
        id: 'team',
        version: `1.0.${version}`,
        extends: { source: './base.json' },
        defaults: { nested: { language: `locale-${version}` } },
        ...(options.browser
          ? {
              packages: {
                simulation: { source: '../simulation/bundle.json', targets: ['browser'] },
              },
              appProfiles: { sample: 'simulation/default' },
            }
          : {}),
        ...(options.external
          ? {
              skills: { helper: { source: 'https://example.com/skills.git' } },
              providers: { device: { source: 'https://example.com/provider.json' } },
            }
          : {}),
      }),
    );
  };
  const profile = encode({ name: 'simulation/default' });
  sources.set('https://example.com/simulation/profile.json', profile);
  sources.set(
    'https://example.com/simulation/bundle.json',
    encode({
      schemaVersion: 1,
      id: 'simulation',
      version: '1.0.0',
      resources: {
        'profile.json': { sha256: await bundleDigest(profile), byteLength: profile.byteLength },
      },
      contributions: { appProfiles: ['profile.json'] },
    }),
  );
  await setVersion(0);
  const load = vi.fn(async (url: string) => {
    const bytes = sources.get(url);
    if (!bytes) throw new Error(`Unexpected source ${url}`);
    return bytes;
  });
  const registries = new Map<
    string,
    NodeCapabilityRegistry<{ started: () => void; name: string }>
  >();
  const started = vi.fn();
  registries.set('first', new NodeCapabilityRegistry({ started, name: 'first' }, directory));
  registries.set('second', new NodeCapabilityRegistry({ started, name: 'second' }, directory));
  const invoke = vi.fn(
    async (action: string, _data: unknown, options: { socketPath?: string } = {}) => {
      const registry = registries.get(options.socketPath!)!;
      let error: string | undefined;
      if (action === 'node_capabilities_reload') {
        try {
          await registry.refresh();
        } catch (failure) {
          error = String(failure);
        }
      }
      return {
        revision: registry.revision ?? null,
        installationRevision: registry.installationRevision ?? null,
        ...(action === 'node_capabilities_reload' ? { accepted: !error, error } : {}),
      };
    },
  );
  const installer = new PresetInstaller({
    directory,
    load,
    hosts: () => [...registries.keys()].map(id => ({ id, socketPath: id })),
    invoke,
  });
  return {
    sources,
    load,
    setVersion,
    installer,
    registries,
    started,
    invoke,
    prepared: () => preparePreset(source, { mearlApiVersion: '1.0.0', load }),
  };
}

describe('preset installation and live selection', () => {
  it('completes setup with CDP alone and synchronizes the same preset when an extension connects', async () => {
    const f = await fixture({ browser: true });
    const { revision } = await f.installer.stage(source);
    const records = vi.mocked(listLiveBrowsers);
    const invoke = vi.mocked(invokeExistingHost);
    const cdp = { browserId: 'cdp', socketPath: 'first', transport: 'cdp' } as ReturnType<
      typeof listLiveBrowsers
    >[number];
    vi.stubEnv('MEARL_SOCKET_PATH', '');
    vi.stubEnv('MEARL_CAPABILITY_DIR', directory);
    records.mockReturnValue([cdp]);
    invoke.mockImplementation(f.invoke);
    try {
      const staged = await prepareSetupPreset({});
      expect(await staged!.activate()).toMatchObject({
        revision,
        ready: true,
        pending: [],
        browsers: [],
      });
      expect(await runPresetCommand('status')).toMatchObject({
        revision,
        ready: true,
        pending: [],
        browsers: [],
      });
      expect(invoke.mock.calls.some(([action]) => action.startsWith('preset_browser_'))).toBe(
        false,
      );

      const extension = {
        ...cdp,
        browserId: 'extension',
        socketPath: 'second',
        transport: 'extension',
      } as const;
      records.mockReturnValue([cdp, extension]);
      const receipt = (await f.installer.store.current()).receipt!;
      let rejectSync = false;
      invoke.mockImplementation(async (action, data, options) => {
        if (action === 'preset_browser_sync' && rejectSync)
          return { accepted: false, error: 'Extension rejected the preset' };
        if (action === 'preset_browser_sync' || action === 'preset_browser_status') {
          return {
            ready: true,
            settingsReady: true,
            installationRevision: revision,
            browserRevision: receipt.browserRevision,
          };
        }
        return f.invoke(action, data, options);
      });
      expect(await runPresetCommand('apply')).toMatchObject({
        revision,
        ready: true,
        browsers: [{ id: 'extension', state: 'active' }],
      });
      expect(invoke.mock.calls.filter(([action]) => action === 'preset_browser_sync')).toEqual([
        [
          'preset_browser_sync',
          { installationRevision: revision },
          { socketPath: 'second', timeoutSec: 130 },
        ],
      ]);
      rejectSync = true;
      expect(await runPresetCommand('apply')).toMatchObject({
        ready: true,
        warnings: [expect.stringContaining('Extension rejected the preset')],
      });
      expect(await runPresetCommand('repair')).toMatchObject({ revision, ready: true });
    } finally {
      invoke.mockReset();
      records.mockReturnValue([]);
      vi.unstubAllEnvs();
    }
  });

  it('reapplies the pinned installation offline and limits replacement authority to one retry', async () => {
    const f = await fixture({ external: true });
    const original = f.invoke.getMockImplementation()!;
    let ready = false;
    f.invoke.mockImplementation(async (...args) => {
      if (!args[0].startsWith('preset_components_')) return original(...args);
      const current = await f.installer.store.current();
      if (args[0] === 'preset_components_install' && (args[1] as any).replaceSkills) ready = true;
      return {
        installationRevision: current.receipt!.revision,
        nodeRevision: current.receipt!.nodeRevision,
        components: [
          {
            kind: 'skills',
            id: 'helper',
            state: ready ? 'ready' : 'conflict',
            ...(!ready ? { reason: 'SKILL_PLUGIN_REGISTRATION_CONFLICT' } : {}),
          },
          { kind: 'providers', id: 'device', state: 'ready' },
        ],
      };
    });
    const installed = await f.installer.apply(source);
    expect(installed.ready).toBe(false);
    f.sources.clear();
    f.load.mockClear();
    f.invoke.mockClear();
    expect(await f.installer.apply(undefined, { replaceSkills: ['helper'] })).toMatchObject({
      ready: true,
      revision: installed.revision,
    });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenCalledWith(
      'preset_components_install',
      { installationRevision: installed.revision, replaceSkills: ['helper'] },
      expect.anything(),
    );
    f.invoke.mockClear();
    await f.installer.apply();
    expect(f.invoke).toHaveBeenCalledWith(
      'preset_components_install',
      { installationRevision: installed.revision },
      expect.anything(),
    );
  });
  it('rejects undeclared or invalid replacement targets before reloading hosts or installing components', async () => {
    const f = await fixture({ external: true });
    await f.installer.apply(source);
    f.invoke.mockClear();
    f.load.mockClear();
    for (const replaceSkills of [
      [],
      ['unknown'],
      ['helper', 'helper'],
      ['../helper'],
      ['constructor'],
    ]) {
      await expect(f.installer.apply(undefined, { replaceSkills })).rejects.toThrow(
        'Invalid Skill replacement selection',
      );
    }
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
  });
  it('does not start a host when retrying without an installed preset or adding replacements to another command', async () => {
    const f = await fixture();
    await expect(f.installer.apply()).rejects.toThrow('No preset is installed');
    await expect(
      runPresetCommand('update', undefined, { replaceSkills: ['helper'] }),
    ).rejects.toThrow('require preset apply without a source');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
  });

  it('keeps browser removal retryable after removing the local selection', async () => {
    vi.stubEnv('HOME', directory);
    vi.stubEnv('USERPROFILE', directory);
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'plugins'));
    vi.stubEnv('MEARL_SOCKET_PATH', '');
    try {
      const f = await fixture({ browser: true });
      const { revision } = await f.installer.stage(source);
      const receipt = (await f.installer.store.current()).receipt!;
      f.load.mockClear();
      const original = f.invoke.getMockImplementation()!;
      let online = false;
      let removed = false;
      let uninstallSupported = false;
      const installationToken = 'a'.repeat(64);
      f.invoke.mockImplementation(async (action, data, options) => {
        if (action === 'preset_browser_status') {
          if (options.socketPath === 'second')
            return {
              browserRevision: 'b'.repeat(64),
              presetId: 'independent',
              presetSource: 'https://example.com/independent.json',
              uninstallSupported: true,
              installationToken: null,
            };
          if (removed) return { browserRevision: null };
          return {
            browserRevision: receipt.browserRevision,
            installationRevision: revision,
            installationToken,
            presetId: 'team',
            presetSource: source,
            uninstallSupported,
          };
        }
        if (action === 'preset_browser_uninstall') {
          expect((await f.installer.store.current()).receipt).toBeUndefined();
          expect(data).toEqual({ browserRevision: receipt.browserRevision, installationToken });
          if (!online) throw new Error('Browser disconnected');
          removed = true;
          return { accepted: true, browserRevision: null };
        }
        return original(action, data, options);
      });
      await expect(f.installer.uninstall()).rejects.toThrow('Update the Native Host and extension');
      expect((await f.installer.store.current()).receipt?.revision).toBe(revision);
      uninstallSupported = true;
      expect(await f.installer.uninstall()).toMatchObject({
        revision: null,
        ready: false,
        warnings: [],
        browsers: [{ id: 'first', state: 'pending', error: 'Browser disconnected' }],
      });
      expect(await readdir(join(directory, 'installations'))).toEqual([]);
      expect(await readdir(join(directory, 'blobs'))).toEqual([]);
      expect(await readdir(join(directory, 'objects'))).toEqual([]);
      online = true;
      await expect(f.installer.uninstall()).rejects.toThrow('Set MEARL_SOCKET_PATH');
      vi.stubEnv('MEARL_SOCKET_PATH', 'stale');
      await expect(f.installer.uninstall()).rejects.toThrow(
        'does not identify a connected extension',
      );
      vi.stubEnv('MEARL_SOCKET_PATH', 'first');
      expect(await f.installer.uninstall()).toMatchObject({
        revision: null,
        ready: true,
        browsers: [{ id: 'first', state: 'active' }],
      });
      expect(await f.installer.uninstall()).toMatchObject({ ready: true, browsers: [] });
      vi.stubEnv('MEARL_SOCKET_PATH', '');
      await expect(f.installer.uninstall()).rejects.toThrow('Set MEARL_SOCKET_PATH');
      expect(f.load).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('repairs missing selected resources through an explicit setup preset before starting a host', async () => {
    const f = await fixture();
    await f.installer.stage(source);
    const current = await f.installer.store.current();
    const resource = Object.values(current.receipt!.bundles[0].manifest.resources)[0];
    await rm(join(directory, 'blobs', `${resource.sha256}.bin`));
    await expect(f.installer.store.current()).rejects.toThrow();
    const repaired = await prepareSetupPreset({ source }, { installer: f.installer });
    expect(repaired?.revision).toBe(current.receipt?.revision);
    expect((await f.installer.store.current()).preset?.id).toBe('team');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.started).not.toHaveBeenCalled();
  });
  it('stages exact resources without starting a host, then activates offline', async () => {
    const f = await fixture();
    const staged = await f.installer.stage(source);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.started).not.toHaveBeenCalled();
    expect((await f.installer.store.current()).receipt?.revision).toBe(staged.revision);
    f.sources.clear();
    f.load.mockClear();
    expect((await staged.activate()).ready).toBe(true);
    expect(f.registries.get('first')!.require<() => string>('sample.value')()).toBe('v0:default');
    expect(f.load).not.toHaveBeenCalled();
  });
  it('rejects a replaced staged selection before starting any host', async () => {
    const f = await fixture();
    const staged = await f.installer.stage(source);
    await f.setVersion(1);
    await f.installer.stage(source);
    await expect(staged.activate()).rejects.toThrow('selected preset changed');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.started).not.toHaveBeenCalled();
  });
  it('activates a staged handle once and keeps the selected preset when a later resume is rejected', async () => {
    const f = await fixture();
    const original = await f.installer.apply(source);
    await f.setVersion(1);
    const staged = await f.installer.stage(source);
    expect((await staged.activate()).ready).toBe(true);
    expect(staged.revision).not.toBe(original.revision);
    f.invoke.mockClear();
    f.invoke.mockResolvedValue({ accepted: false, error: 'rejected' } as any);
    await expect(staged.activate()).rejects.toThrow('already activated');
    expect(f.invoke).not.toHaveBeenCalled();
    await expect(f.installer.resume(staged.revision)).rejects.toThrow(
      'installed selection retained',
    );
    expect((await f.installer.store.current()).receipt?.revision).toBe(staged.revision);
  });
  it('pins external acceptance to the current selection, expected identity and a final confirmation', async () => {
    const f = await fixture();
    await expect(
      f.installer.apply(source, { expectedId: 'other', expectedRevision: null }),
    ).rejects.toThrow('identity');
    expect((await f.installer.store.current()).receipt).toBeUndefined();
    const confirm = vi.fn(async () => {
      throw new Error('acceptance revoked');
    });
    await expect(f.installer.apply(source, { expectedRevision: null, confirm })).rejects.toThrow(
      'acceptance revoked',
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(f.started).not.toHaveBeenCalled();
    const accepted = await f.installer.apply(source, {
      expectedRevision: null,
      expectedId: 'team',
    });
    f.load.mockClear();
    await expect(f.installer.apply(source, { expectedRevision: null })).rejects.toThrow(
      'changed before preparation',
    );
    expect(f.load).not.toHaveBeenCalled();
    expect((await f.installer.status()).revision).toBe(accepted.revision);
  });
  it('uses the local auto-start route when no browser is connected', async () => {
    const fixtureValue = await fixture();
    const registry = fixtureValue.registries.get('first')!;
    const invoke = vi.fn(
      async (action: string, _data: unknown, options: { socketPath?: string } = {}) => {
        expect(options.socketPath).toBe(
          action === 'node_capabilities_reload' ? undefined : SOCKET_PATH,
        );
        if (action === 'node_capabilities_reload') await registry.refresh();
        return {
          revision: registry.revision,
          installationRevision: registry.installationRevision,
          ...(action === 'node_capabilities_reload' ? { accepted: true } : {}),
        };
      },
    );
    const installer = new PresetInstaller({ directory, load: fixtureValue.load, invoke });
    const result = await installer.apply(source);
    expect(result.ready).toBe(true);
    expect(result.hosts).toEqual([{ id: 'local', state: 'active' }]);
    expect(invoke).toHaveBeenCalledWith(
      'node_capabilities_reload',
      { structured: true },
      { socketPath: undefined, timeoutSec: 15 },
    );
  });

  it('installs external components once on a local host and reports only actual acknowledged readiness', async () => {
    const { installer, sources, invoke } = await fixture();
    const manifest = JSON.parse(new TextDecoder().decode(sources.get(source)!));
    manifest.skills = { helper: { source: 'example/skills', version: '^3' } };
    sources.set(source, encode(manifest));
    const original = invoke.getMockImplementation()!;
    let installed = false;
    invoke.mockImplementation(async (...args) => {
      if (!args[0].startsWith('preset_components_')) return original(...args);
      const current = await installer.store.current();
      if (args[0] === 'preset_components_install') installed = true;
      return {
        installationRevision: current.receipt!.revision,
        nodeRevision: current.receipt!.nodeRevision,
        components: [
          {
            kind: 'skills',
            id: 'helper',
            state: installed ? 'ready' : 'pending',
            ...(installed ? {} : { reason: 'SKILL_NOT_INSTALLED' }),
          },
        ],
      };
    });
    expect((await installer.apply(source)).ready).toBe(true);
    expect(
      invoke.mock.calls.filter(([action]) => action === 'preset_components_install'),
    ).toHaveLength(1);
    expect(
      invoke.mock.calls.find(([action]) => action === 'preset_components_install')?.[2]?.socketPath,
    ).toBe('first');
    installed = false;
    expect((await installer.status()).pending).toContainEqual({
      kind: 'skills',
      id: 'helper',
      runtime: 'node',
      reason: 'SKILL_NOT_INSTALLED',
    });
  });

  it('retains the accepted selection and reports partial installation failures for retry', async () => {
    const { installer, sources, invoke } = await fixture();
    const manifest = JSON.parse(new TextDecoder().decode(sources.get(source)!));
    manifest.skills = { helper: { source: 'example/skills' } };
    sources.set(source, encode(manifest));
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (...args) => {
      if (args[0] === 'preset_components_install') throw new Error('download failed');
      if (args[0] === 'preset_components_status') {
        const current = await installer.store.current();
        return {
          installationRevision: current.receipt!.revision,
          nodeRevision: current.receipt!.nodeRevision,
          components: [
            { kind: 'skills', id: 'helper', state: 'pending', reason: 'SKILL_NOT_INSTALLED' },
          ],
        };
      }
      return original(...args);
    });
    const result = await installer.apply(source);
    expect(result.ready).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining('download failed'));
    expect((await installer.store.current()).receipt?.revision).toBe(result.revision);
  });

  it('atomically binds the receipt, exact resources and both host acknowledgements', async () => {
    const { installer, registries, started, load } = await fixture();
    const result = await installer.apply(source, {
      overrides: { capabilities: { value: { suffix: 'configured' } } },
    });
    expect(result).toMatchObject({
      id: 'team',
      version: '1.0.0',
      ready: true,
      pending: [],
      hosts: [
        { id: 'first', state: 'active' },
        { id: 'second', state: 'active' },
      ],
    });
    expect(registries.get('first')!.require<() => string>('sample.value')()).toBe('v0:configured');
    expect(started).toHaveBeenCalledTimes(2);
    const reads = load.mock.calls.length;
    load.mockRejectedValue(new Error('offline'));
    expect((await installer.status()).ready).toBe(true);
    expect(load).toHaveBeenCalledTimes(reads);
    expect(
      (await new PresetInstallationStore({ directory }).current()).prepared?.browser.bundles,
    ).toEqual([]);
  });

  it('projects inherited capability defaults into Node without freezing them as explicit configuration', async () => {
    const { installer, sources, registries } = await fixture();
    const setSuffix = (suffix: string) => {
      const parent = JSON.parse(new TextDecoder().decode(sources.get(base)!));
      parent.defaults.capabilities = { value: { suffix } };
      sources.set(base, encode(parent));
    };
    setSuffix('parent');
    await installer.apply(source);
    expect(registries.get('first')!.require<() => string>('sample.value')()).toBe('v0:parent');
    expect((await installer.store.current()).receipt?.overrides.capabilities).toBeUndefined();
    setSuffix('updated');
    await installer.update();
    expect(registries.get('first')!.require<() => string>('sample.value')()).toBe('v0:updated');
    expect((await installer.store.current()).receipt?.overrides.capabilities).toBeUndefined();
    await installer.configure({ capabilities: { value: { suffix: 'user-choice' } } });
    expect(registries.get('first')!.require<() => string>('sample.value')()).toBe('v0:user-choice');
    await installer.apply(source, {
      overrides: { capabilities: { value: { suffix: 'host-choice' } } },
    });
    expect(registries.get('first')!.require<() => string>('sample.value')()).toBe('v0:host-choice');
    const restored = await new PresetInstallationStore({ directory }).current();
    expect(restored.receipt?.overrides.capabilities).toEqual({ value: { suffix: 'host-choice' } });
    expect(restored.receipt?.overrides).toEqual({
      capabilities: { value: { suffix: 'host-choice' } },
    });
  });

  it('accepts resource-only packages without requiring a Node module factory', async () => {
    const { installer, sources } = await fixture();
    const bytes = encode({ example: true });
    const manifest = {
      schemaVersion: 1,
      id: 'data',
      version: '1.0.0',
      resources: { 'data.json': { sha256: await bundleDigest(bytes), byteLength: bytes.length } },
    };
    sources.set('https://example.com/data/bundle.json', encode(manifest));
    sources.set('https://example.com/data/data.json', bytes);
    const preset = JSON.parse(new TextDecoder().decode(sources.get(source)!));
    preset.packages = { data: { source: '../data/bundle.json', targets: ['node'] } };
    sources.set(source, encode(preset));
    expect(await installer.apply(source)).toMatchObject({ ready: true, pending: [] });
  });

  it('restores one target graph when inferred and explicit package choices are mixed', async () => {
    const { installer, sources } = await fixture({ browser: true });
    const parent = JSON.parse(new TextDecoder().decode(sources.get(base)!));
    delete parent.packages.value.targets;
    sources.set(base, encode(parent));
    await installer.apply(source);
    const restored = await installer.store.current({ verifyResources: false });
    expect(restored.preset?.packages.value.targets).toEqual(['node']);
    expect(restored.preset?.packages.simulation.targets).toEqual(['browser']);
    const status = await installer.status();
    expect(status.hosts.every(host => host.state === 'active')).toBe(true);
    expect(status.pending).toContainEqual({
      kind: 'packages',
      id: 'simulation',
      runtime: 'browser',
      reason: 'BROWSER_SYNC_REQUIRED',
    });
  });

  it('preserves explicit overrides across updates even when they equal old defaults', async () => {
    const { installer, setVersion, registries, started } = await fixture();
    await installer.apply(source, {
      overrides: {
        nested: { language: 'locale-0' },
        array: [],
        capabilities: { value: { suffix: 'kept' } },
      },
    });
    const pinned = registries.get('first')!.require<() => string>('sample.value');
    await setVersion(1);
    const next = await installer.update();
    expect(next.settings).toEqual({
      nested: { language: 'locale-0', inherited: true },
      array: [],
      capabilities: { value: { suffix: 'kept' } },
    });
    expect(next.overrides).toEqual({
      nested: { language: 'locale-0' },
      array: [],
      capabilities: { value: { suffix: 'kept' } },
    });
    expect(registries.get('first')!.require<() => string>('sample.value')()).toBe('v1:kept');
    expect(pinned()).toBe('v0:kept');
    const count = started.mock.calls.length;
    const reset = await installer.configure({});
    expect(reset.settings).toEqual({
      nested: { language: 'locale-1', inherited: true },
      array: [1, 2],
    });
    expect(started).toHaveBeenCalledTimes(count + 2);
    expect(reset.hosts.every(host => host.state === 'active')).toBe(true);
  });

  it('keeps browser, unsupported Node hosts and external components pending', async () => {
    const { installer, sources } = await fixture({ browser: true, external: true });
    const manifestUrl = 'https://example.com/value/bundle.json';
    const manifest = JSON.parse(new TextDecoder().decode(sources.get(manifestUrl)!));
    manifest.contributions.nodeRuntimes.worker = manifest.contributions.nodeRuntimes['native-host'];
    delete manifest.contributions.nodeRuntimes['native-host'];
    sources.set(manifestUrl, encode(manifest));
    const result = await installer.apply(source);
    expect(result.ready).toBe(false);
    expect(result.pending).toEqual(
      expect.arrayContaining([
        { kind: 'packages', id: 'value', runtime: 'node', reason: 'NODE_HOST_NOT_SUPPORTED' },
        { kind: 'packages', id: 'simulation', runtime: 'browser', reason: 'BROWSER_SYNC_REQUIRED' },
        { kind: 'skills', id: 'helper', runtime: 'node', reason: 'INSTALL_REQUIRED' },
        { kind: 'providers', id: 'device', runtime: 'node', reason: 'INSTALL_REQUIRED' },
      ]),
    );
  });

  it('resumes the accepted installation offline without re-fetching or replacing its overrides', async () => {
    const f = await fixture();
    const installed = await f.installer.apply(source, {
      overrides: { nested: { language: 'kept' } },
    });
    f.load.mockClear();
    f.load.mockRejectedValue(new Error('source offline'));
    expect(await f.installer.resume(installed.revision!)).toMatchObject({
      ready: true,
      revision: installed.revision,
      overrides: { nested: { language: 'kept' } },
    });
    expect(f.load).not.toHaveBeenCalled();
    await expect(f.installer.resume('f'.repeat(64))).rejects.toThrow('changed before resuming');
  });
  it('installs offline and activates on a later host without fetching again', async () => {
    const { installer, registries, load } = await fixture();
    const offline = new PresetInstaller({ directory, load, hosts: () => [] });
    const result = await offline.apply(source);
    expect(result.ready).toBe(false);
    expect(result.pending[0].reason).toBe('HOST_SYNC_REQUIRED');
    load.mockRejectedValue(new Error('offline'));
    for (const registry of registries.values()) await registry.refresh();
    expect((await installer.status()).ready).toBe(true);
  });

  it('restores the old selection on a confirmed factory rejection and preserves in-flight handlers', async () => {
    const { installer, setVersion, registries } = await fixture();
    const first = await installer.apply(source);
    const pinned = registries.get('first')!.require<() => string>('sample.value');
    await setVersion(1, 'module.exports = () => { throw new Error("factory rejected") }');
    await expect(installer.update()).rejects.toThrow('previous selection restored');
    expect((await installer.status()).revision).toBe(first.revision);
    expect(pinned()).toBe('v0:default');
    expect(registries.get('first')!.require<() => string>('sample.value')()).toBe('v0:default');
    const cold = new NodeCapabilityRegistry({ started: () => {} }, directory);
    await cold.refresh();
    expect(cold.require<() => string>('sample.value')()).toBe('v0:default');
  });
  it('rolls back a host that accepted when another host rejects the same candidate', async () => {
    const { installer, setVersion, registries } = await fixture();
    const first = await installer.apply(source);
    await setVersion(
      1,
      'module.exports = host => { if (host.name === "second") throw new Error("second rejected"); return { value: () => "candidate" } }',
    );
    await expect(installer.update()).rejects.toThrow('previous selection restored');
    for (const registry of registries.values()) {
      expect(registry.installationRevision).toBe(first.revision);
      expect(registry.require<() => string>('sample.value')()).toBe('v0:default');
    }
  });
  it('keeps a verified previous selection usable when an offline candidate fails on cold start', async () => {
    const { installer, setVersion, load } = await fixture();
    const first = await installer.apply(source);
    await setVersion(1, 'module.exports = () => { throw new Error("cold candidate rejected") }');
    const offline = new PresetInstaller({ directory, load, hosts: () => [] });
    expect((await offline.apply(source)).ready).toBe(false);
    const cold = new NodeCapabilityRegistry({ started: () => {} }, directory);
    await expect(cold.refresh()).rejects.toThrow('cold candidate rejected');
    expect(cold.installationRevision).toBe(first.revision);
    expect(cold.require<() => string>('sample.value')()).toBe('v0:default');
  });

  it('keeps a valid installation pending when a host disconnects and does not execute status probes', async () => {
    const { installer, started } = await fixture();
    await installer.apply(source);
    const unavailable = new PresetInstaller({
      directory,
      hosts: () => [{ id: 'gone', socketPath: 'missing' }],
      invoke: vi.fn().mockRejectedValue(new Error('Disconnected')),
    });
    const count = started.mock.calls.length;
    expect((await unavailable.status()).hosts).toEqual([
      { id: 'gone', state: 'pending', error: 'HOST_UNAVAILABLE' },
    ]);
    expect(started).toHaveBeenCalledTimes(count);
  });
  it('does not execute a historical rollback when unchanged installation synchronization is rejected', async () => {
    const { installer, load } = await fixture();
    const first = await installer.apply(source);
    const rejecting = new PresetInstaller({
      directory,
      load,
      hosts: () => [{ id: 'cold', socketPath: 'cold' }],
      invoke: vi.fn().mockResolvedValue({ accepted: false, error: 'new host rejected' }),
    });
    await expect(rejecting.apply(source)).rejects.toThrow('installed selection retained');
    expect((await installer.status()).revision).toBe(first.revision);
  });
  it('requires host acknowledgement when the final Node package is disabled', async () => {
    const { installer, sources, load } = await fixture();
    await installer.apply(source);
    const value = JSON.parse(new TextDecoder().decode(sources.get(source)!));
    value.packages = { value: { enabled: false } };
    sources.set(source, encode(value));
    const offline = new PresetInstaller({ directory, load, hosts: () => [] });
    const pending = await offline.apply(source);
    expect(pending.ready).toBe(false);
    expect(pending.pending).toEqual([
      { kind: 'preset', id: 'team', runtime: 'node', reason: 'HOST_SYNC_REQUIRED' },
    ]);
    expect((await installer.update()).ready).toBe(true);
  });
  it('retains module configuration across child disabling and re-enabling', async () => {
    const { installer, sources, registries } = await fixture();
    await installer.apply(source, {
      overrides: { capabilities: { value: { suffix: 'retained' } } },
    });
    const value = JSON.parse(new TextDecoder().decode(sources.get(source)!));
    sources.set(source, encode({ ...value, packages: { value: { enabled: false } } }));
    await installer.update();
    expect(registries.get('first')!.get('sample.value')).toBeUndefined();
    expect((await installer.store.current()).receipt?.overrides.capabilities).toEqual({
      value: { suffix: 'retained' },
    });
    sources.set(source, encode(value));
    await installer.update();
    expect(registries.get('first')!.require<() => string>('sample.value')()).toBe('v0:retained');
  });
  it('cancels preparation without changing the active selection', async () => {
    const { installer, load } = await fixture();
    const first = await installer.apply(source);
    const controller = new AbortController();
    controller.abort();
    load.mockClear();
    await expect(installer.apply(source, { signal: controller.signal })).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
    expect((await installer.status()).revision).toBe(first.revision);
  });

  it('repairs missing/corrupt bytes from a verified reinstallation and keeps failed downloads atomic', async () => {
    const { installer, sources } = await fixture();
    const first = await installer.apply(source);
    const blob = (await readdir(join(directory, 'blobs')))[0];
    await writeFile(join(directory, 'blobs', blob), 'corrupt');
    await expect(installer.status()).rejects.toThrow();
    expect((await installer.apply(source)).revision).toBe(first.revision);
    sources.set('https://example.com/value/runtime.cjs', new Uint8Array([0]));
    await expect(installer.apply(source)).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    expect((await installer.status()).revision).toBe(first.revision);
  });

  it('compares the selected revision at commit time and refuses stale rollback', async () => {
    const { prepared, installer, setVersion } = await fixture();
    const store = installer.store;
    const one = await prepared();
    await setVersion(1);
    const two = await prepared();
    const results = await Promise.allSettled([
      store.apply(one, { expectedRevision: null }),
      store.apply(two, { expectedRevision: null }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { code: 'BUNDLE_CONFLICT' },
    });
    const current = await store.current();
    const replacement = current.receipt!.snapshot.revision === one.snapshot.revision ? two : one;
    const installed = await store.apply(replacement, {
      expectedRevision: presetSelectionRevision(current),
    });
    await expect(store.rollback(current.receipt!.revision)).rejects.toMatchObject({
      code: 'BUNDLE_CONFLICT',
    });
    expect((await store.current()).receipt?.revision).toBe(installed.revision);
  });
  it('does not report another installation as the result of a pending host synchronization', async () => {
    const { installer, invoke } = await fixture();
    const original = invoke.getMockImplementation()!;
    let switched = false;
    invoke.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[0] === 'node_capabilities_reload' && !switched) {
        switched = true;
        const current = await installer.store.current();
        await installer.store.apply(current.prepared!, {
          expectedRevision: presetSelectionRevision(current),
          overrides: { concurrent: true },
        });
      }
      return response;
    });
    await expect(installer.apply(source)).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
    expect((await installer.store.current()).receipt?.overrides).toEqual({ concurrent: true });
  });

  it('preserves independent Node modules and rejects module or hook takeover', async () => {
    const bytes = Buffer.from('module.exports = () => ({ extra: () => "independent" })');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const independent = await prepareCapabilitySnapshot({
      schemaVersion: 1,
      modules: { independent: { sha256, byteLength: bytes.byteLength } },
      bindings: { 'extra.value': { module: 'independent', handler: 'extra' } },
    });
    await mkdir(join(directory, 'objects'));
    await writeFile(join(directory, 'objects', `${sha256}.cjs`), bytes);
    await writeFile(join(directory, 'active-node.json'), JSON.stringify(independent));
    const { installer, registries, setVersion, sources } = await fixture();
    await installer.apply(source);
    await setVersion(1);
    await installer.update();
    expect(registries.get('first')!.require<() => string>('extra.value')()).toBe('independent');
    const manifestUrl = 'https://example.com/value/bundle.json';
    const manifest = JSON.parse(new TextDecoder().decode(sources.get(manifestUrl)!));
    manifest.contributions.nodeRuntimes['native-host'].bindings = { 'extra.value': 'value' };
    sources.set(manifestUrl, encode(manifest));
    await expect(installer.update()).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
    expect(registries.get('first')!.require<() => string>('extra.value')()).toBe('independent');
    const current = await installer.store.current();
    await expect(installer.store.uninstall('a'.repeat(64))).rejects.toMatchObject({
      code: 'BUNDLE_CONFLICT',
    });
    expect(await installer.store.uninstall(current.receipt!.revision)).toEqual(independent);
    await installer.store.collectGarbage();
    expect(await readdir(join(directory, 'objects'))).toEqual([`${sha256}.cjs`]);
    await registries.get('first')!.refresh();
    expect(registries.get('first')!.require<() => string>('extra.value')()).toBe('independent');
    expect(registries.get('first')!.installationRevision).toBeUndefined();
  });

  it('performs independent-module preparation before asking the external commit confirmation', async () => {
    const bytes = Buffer.from('module.exports=()=>({value:()=>1})');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const independent = await prepareCapabilitySnapshot({
      schemaVersion: 1,
      modules: { value: { sha256, byteLength: bytes.length } },
      bindings: { 'extra.value': { module: 'value', handler: 'value' } },
    });
    await mkdir(join(directory, 'objects'));
    await writeFile(join(directory, 'objects', sha256 + '.cjs'), bytes);
    await writeFile(join(directory, 'active-node.json'), JSON.stringify(independent));
    const f = await fixture();
    const confirm = vi.fn(async () => {});
    await expect(f.installer.apply(source, { confirm })).rejects.toThrow(
      'independently installed Node module',
    );
    expect(confirm).not.toHaveBeenCalled();
    expect((await f.installer.store.current()).activation?.revision).toBe(independent.revision);
  });
  it('reclaims obsolete objects while retaining the active and immediate rollback snapshots', async () => {
    const { installer, setVersion } = await fixture({ browser: true });
    let previous: string | null = null;
    for (let index = 0; index < 8; index++) {
      await setVersion(index);
      const next = await installer.apply(source);
      if (index > 0) expect(next.revision).not.toBe(previous);
      previous = next.revision;
      expect((await readdir(join(directory, 'objects'))).length).toBeLessThanOrEqual(2);
      expect((await readdir(join(directory, 'blobs'))).length).toBeLessThanOrEqual(3);
      expect((await readdir(join(directory, 'installations'))).length).toBeLessThanOrEqual(2);
    }
    await installer.store.rollback(previous!);
    expect((await installer.status()).version).toBe('1.0.6');
  });

  it('rejects receipt corruption and preserves the pointer when overrides exceed the limit', async () => {
    const { installer } = await fixture();
    const first = await installer.apply(source);
    await expect(installer.configure({ value: 'x'.repeat(262_145) })).rejects.toMatchObject({
      code: 'BUNDLE_QUOTA',
    });
    expect((await installer.status()).revision).toBe(first.revision);
    const file = join(directory, 'installations', `${first.revision}.json`);
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    receipt.overrides = { modified: true };
    await writeFile(file, JSON.stringify(receipt));
    await expect(installer.status()).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
  });
});

describe('Node preset file loader', () => {
  it('bounds local reads, refuses symlinks and respects an already cancelled request', async () => {
    const load = createNodePresetLoader();
    const file = join(directory, 'value.json');
    await writeFile(file, 'content');
    expect(Buffer.from(await load(pathToFileURL(file).href, { maxBytes: 7 })).toString()).toBe(
      'content',
    );
    await expect(load(pathToFileURL(file).href, { maxBytes: 6 })).rejects.toMatchObject({
      code: 'BUNDLE_QUOTA',
    });
    const link = join(directory, 'link.json');
    await symlink(file, link);
    await expect(load(pathToFileURL(link).href, { maxBytes: 7 })).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      load(pathToFileURL(file).href, { maxBytes: 7, signal: controller.signal }),
    ).rejects.toThrow();
    await expect(load('http://example.com/preset.json', { maxBytes: 100 })).rejects.toMatchObject({
      code: 'BUNDLE_INVALID',
    });
  });
});

it('requires an explicit plugin catalog acknowledgement even without external components', async () => {
  const f = await fixture();
  const url = 'https://example.com/value/bundle.json';
  const bundle = JSON.parse(new TextDecoder().decode(f.sources.get(url)!));
  bundle.contributions.nodeRuntimes['native-host'].bindings['plugins.catalog'] = 'value';
  f.sources.set(url, encode(bundle));
  const original = f.invoke.getMockImplementation()!;
  let catalogReady = false;
  f.invoke.mockImplementation(async (...args) => {
    if (!args[0].startsWith('preset_components_')) return original(...args);
    const current = await f.installer.store.current();
    return {
      installationRevision: current.receipt!.revision,
      nodeRevision: current.receipt!.nodeRevision,
      components: [],
      catalogReady,
    };
  });
  expect((await f.installer.apply(source)).pending).toContainEqual({
    kind: 'preset',
    id: 'team',
    runtime: 'node',
    reason: 'PLUGIN_CATALOG_SYNC_REQUIRED',
  });
  catalogReady = true;
  expect((await f.installer.status()).ready).toBe(true);
});

it('does not start a cold host while reading preset status, but permits explicit synchronization to start it', async () => {
  const f = await fixture({ external: true });
  await f.installer.apply(source);
  vi.stubEnv('MEARL_SOCKET_PATH', '');
  vi.mocked(invokeLocalHost).mockReset();
  vi.mocked(invokeExistingHost).mockReset().mockRejectedValue(new Error('Cold host unavailable'));
  try {
    const installer = new PresetInstaller({ directory, load: f.load });
    const status = await installer.status();
    expect(status.ready).toBe(false);
    expect(status.hosts).toEqual([{ id: 'local', state: 'pending', error: 'HOST_UNAVAILABLE' }]);
    expect(invokeExistingHost).toHaveBeenCalledWith(
      'node_capabilities_status',
      {},
      expect.objectContaining({ socketPath: SOCKET_PATH }),
    );
    expect(status.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'skills', reason: 'INSTALL_REQUIRED' }),
      ]),
    );
    expect(invokeLocalHost).not.toHaveBeenCalled();
    vi.mocked(invokeLocalHost).mockRejectedValue(new Error('Host could not start'));
    await installer.resume(status.revision!);
    expect(invokeLocalHost).toHaveBeenCalledWith(
      'node_capabilities_reload',
      { structured: true },
      expect.objectContaining({ socketPath: undefined }),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it('checks a prepared update before commit, retaining overrides and skipping unchanged activation', async () => {
  const f = await fixture();
  const initial = await f.installer.apply(source);
  f.started.mockClear();
  expect((await f.installer.update({ skipUnchanged: true })).revision).toBe(initial.revision);
  expect(f.started).not.toHaveBeenCalled();
  await f.setVersion(1);
  await expect(
    f.installer.update({
      validatePrepared: async () => {
        throw new Error('permission required');
      },
    }),
  ).rejects.toThrow('permission required');
  expect((await f.installer.status()).revision).toBe(initial.revision);
});
