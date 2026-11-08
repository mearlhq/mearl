import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseInstallationConfig } from '@mearl/preset/installation';
import { prepareBrowserSetupPreset } from '../browserPreset.js';
import { PresetInstaller } from '../preset.js';

let directory: string;
const source = 'https://assets.example.test/preset.json';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mearl-browser-adoption-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function fixture() {
  const browser = { browserId: 'browser-1', socketPath: '/fixture/socket', transport: 'extension', status: 'connected' } as any;
  const selection = { browserReady: true, presetId: 'team', presetSource: source, browserRevision: 'a'.repeat(64) };
  const config = parseInstallationConfig({ schemaVersion: 1, guide: { url: 'https://guide.example.test/', registry: 'https://registry.example.test/' }, presets: { team: { label: 'Team', source, origins: [] } } }, 'https://public.example.test');
  const sources = new Map([[source, encode({ schemaVersion: 1, id: 'team', version: '1.0.0' })]]);
  const load = vi.fn(async (url: string) => { const bytes = sources.get(url); if (!bytes) throw new Error('offline'); return bytes; });
  const configuration = vi.fn(async () => structuredClone(config));
  const invoke = vi.fn(async () => structuredClone(selection));
  const browsers = vi.fn(() => [browser]);
  const options = { env: { MEARL_CAPABILITY_DIR: directory } };
  const dependencies = { browsers, invoke, configuration, load };
  return { browser, selection, config, sources, load, configuration, invoke, browsers, options, dependencies };
}

it('stages one trusted browser preset and rechecks its identity and trust before committing', async () => {
  const f = fixture();
  const plan = await prepareBrowserSetupPreset(f.options, f.dependencies);
  expect(plan?.revision).toBe((await new PresetInstaller({ directory }).store.current()).receipt?.revision);
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.invoke.mock.calls[0]).toEqual(['preset_browser_status', {}, { socketPath: f.browser.socketPath, timeoutSec: 5 }]);
  expect(f.configuration).toHaveBeenCalledTimes(2);
});
it('keeps a local selection without querying browsers or trust', async () => {
  const f = fixture();
  await new PresetInstaller({ directory, load: f.load }).stage(source, { overrides: { user: { value: true } } });
  expect(await prepareBrowserSetupPreset(f.options, f.dependencies)).toBeUndefined();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.configuration).not.toHaveBeenCalled();
});
it('ignores Provider and CDP targets and honors the explicit local socket', async () => {
  const f = fixture();
  f.browsers.mockReturnValue([{ ...f.browser, provider: {} }, { ...f.browser, transport: 'cdp' }]);
  expect(await prepareBrowserSetupPreset(f.options, f.dependencies)).toBeUndefined();
  f.browsers.mockReturnValue([f.browser]);
  expect(await prepareBrowserSetupPreset({ ...f.options, env: { ...f.options.env, MEARL_SOCKET_PATH: '/other' } }, f.dependencies)).toBeUndefined();
  expect(f.invoke).not.toHaveBeenCalled();
});
it('accepts matching selections across browsers but refuses conflicting presets', async () => {
  const f = fixture();
  f.browsers.mockReturnValue([f.browser, { ...f.browser, browserId: 'browser-2', socketPath: '/fixture/2' }]);
  f.invoke.mockImplementationOnce(async () => f.selection).mockImplementationOnce(async () => ({ ...f.selection, presetId: 'other' }));
  await expect(prepareBrowserSetupPreset(f.options, f.dependencies)).rejects.toThrow('different presets');
  expect(f.load).not.toHaveBeenCalled();
  expect(await prepareBrowserSetupPreset(f.options, f.dependencies)).toBeDefined();
});
it.each(['source', 'id'])('requires exact trusted %s before downloading any resources', async field => {
  const f = fixture();
  if (field === 'source') f.selection.presetSource = 'https://other.example.test/preset.json';
  else f.selection.presetId = 'other';
  await expect(prepareBrowserSetupPreset(f.options, f.dependencies)).rejects.toThrow('not in the trusted');
  expect(f.load).not.toHaveBeenCalled();
});
it.each(['trust', 'selection', 'local'])('rejects concurrent changes to %s', async kind => {
  const f = fixture();
  const load = async (url: string) => {
    if (kind === 'trust') f.config.presets!.team.source = 'https://assets.example.test/changed.json';
    if (kind === 'selection') f.selection.browserRevision = 'b'.repeat(64);
    if (kind === 'local') await new PresetInstaller({ directory, load: f.load }).stage(source);
    return f.load(url);
  };
  await expect(prepareBrowserSetupPreset(f.options, { ...f.dependencies, load })).rejects.toThrow(kind === 'trust' ? 'trust changed' : kind === 'selection' ? 'browser preset changed' : /changed|conflict/i);
  if (kind !== 'local') expect((await new PresetInstaller({ directory }).store.current()).activation).toBeUndefined();
});
it('restricts inherited resources and permissions to the catalog, and checks the downloaded ID', async () => {
  const f = fixture();
  f.sources.set(source, encode({ schemaVersion: 1, id: 'team', version: '1.0.0', extends: { source: 'https://untrusted.example.test/base.json' } }));
  await expect(prepareBrowserSetupPreset(f.options, f.dependencies)).rejects.toThrow('outside the trusted');
  expect(f.load).toHaveBeenCalledTimes(1);
  f.sources.set(source, encode({ schemaVersion: 1, id: 'team', version: '1.0.0', permissions: { origins: ['https://untrusted.example.test/*'] } }));
  await expect(prepareBrowserSetupPreset(f.options, f.dependencies)).rejects.toThrow('permissions exceed');
  f.sources.set(source, encode({ schemaVersion: 1, id: 'other', version: '1.0.0' }));
  await expect(prepareBrowserSetupPreset(f.options, f.dependencies)).rejects.toThrow('preset identity');
});
it('continues without a browser preset if the extension is absent, disconnected or has no selection', async () => {
  const f = fixture();
  f.browsers.mockReturnValue([]);
  expect(await prepareBrowserSetupPreset(f.options, f.dependencies)).toBeUndefined();
  expect(f.browsers).toHaveBeenCalledOnce();
  expect(f.invoke).not.toHaveBeenCalled();
  f.browsers.mockReturnValueOnce([f.browser]);
  f.invoke.mockRejectedValueOnce(new Error('Socket closed'));
  expect(await prepareBrowserSetupPreset(f.options, f.dependencies)).toBeUndefined();
  f.browsers.mockReturnValue([f.browser]);
  f.invoke.mockResolvedValueOnce({ error: 'EXTENSION_NOT_CONNECTED' } as any);
  expect(await prepareBrowserSetupPreset(f.options, f.dependencies)).toBeUndefined();
  f.invoke.mockResolvedValue({ browserReady: false, browserRevision: null } as any);
  expect(await prepareBrowserSetupPreset(f.options, f.dependencies)).toBeUndefined();
  expect(f.configuration).not.toHaveBeenCalled();
});
it('reports an unreadable or unsupported host when its connection state is unknown', async () => {
  const f = fixture();
  f.invoke.mockRejectedValueOnce(new Error('disconnected'));
  await expect(prepareBrowserSetupPreset(f.options, f.dependencies)).rejects.toThrow('Cannot read');
  f.invoke.mockResolvedValue({} as any);
  await expect(prepareBrowserSetupPreset(f.options, f.dependencies)).rejects.toThrow('unavailable');
  expect(f.load).not.toHaveBeenCalled();
});

it('probes live extension records that omit the optional connection status', async () => {
  const f = fixture();
  delete f.browser.status;
  expect(await prepareBrowserSetupPreset(f.options, f.dependencies)).toBeDefined();
  expect(f.invoke).toHaveBeenCalledTimes(2);
});
it.each(['pairing', 'running_disconnected', 'stopped'])('does not adopt a browser explicitly marked %s', async status => {
  const f = fixture();
  f.browser.status = status;
  expect(await prepareBrowserSetupPreset(f.options, f.dependencies)).toBeUndefined();
  expect(f.invoke).not.toHaveBeenCalled();
});
