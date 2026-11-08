import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ browsers: vi.fn(), invoke: vi.fn(), disconnect: vi.fn(), options: vi.fn(), config: null as null | { server: string } }));
vi.mock('../browserRegistry.js', () => ({ listLiveBrowsers: state.browsers }));
vi.mock('node:fs', () => ({ existsSync: () => Boolean(state.config), readFileSync: () => JSON.stringify(state.config) }));
vi.mock('../unified.js', () => ({ UnifiedClient: class { constructor(options: unknown) { state.options(options); } invoke = state.invoke; disconnect = state.disconnect; } }));
import { readHelpCapabilities, formatCapabilityHelp } from '../capabilityHelp.js';
const catalog = { actions: [], devicePresets: [], apps: { status: 'available' as const, entries: [{ id: 'example/app', label: 'Example', source: 'plugin' as const, available: false, features: ['jsBridge'], usage: { description: 'Example usage', skills: ['example-guide'], documentation: [{ title: 'Guide', url: 'https://example.com/guide' }], limitations: ['Needs a device'] } }], issues: [] }, limitations: ['Not authorization'], help: { skill: 'mearl', commands: [] } };
beforeEach(() => { vi.resetAllMocks(); state.config = null; vi.stubEnv('MEARL_SERVER_URL', ''); state.browsers.mockReturnValue([{}]); state.invoke.mockResolvedValue(catalog); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it('does not start an offline local environment to print help', async () => {
  state.browsers.mockReturnValue([]);
  expect(await readHelpCapabilities(['--help'])).toBeUndefined();
  expect(state.invoke).not.toHaveBeenCalled();
});
it('uses the selected browser and control session for read-only discovery', async () => {
  expect(await readHelpCapabilities(['set_app_profile', '--help', '--browser=target', '--session', 's1'])).toEqual(catalog);
  expect(state.invoke).toHaveBeenCalledWith('get_capabilities', {}, { browser: 'target', session: 's1' });
  expect(state.disconnect).toHaveBeenCalledOnce();
});
it('bounds discovery and falls back to static help', async () => {
  vi.useFakeTimers(); state.invoke.mockReturnValue(new Promise(() => {}));
  const result = readHelpCapabilities(['--help']);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await result).toBeUndefined();
  expect(state.disconnect).toHaveBeenCalledOnce();
});
it('retains partial and unavailable state and prints useful documentation instead of object strings', () => {
  const help = formatCapabilityHelp(catalog, true);
  for (const value of ['example/app', '暂不可用', 'example-guide', 'Guide https://example.com/guide', 'Needs a device', 'Not authorization']) expect(help).toContain(value);
  expect(help).not.toContain('[object Object]');
  expect(formatCapabilityHelp({ ...catalog, apps: { ...catalog.apps, entries: [], status: 'partial' } })).toContain('安装状态待确认');
  expect(formatCapabilityHelp(undefined)).toContain('静态帮助');
});

it('uses configured remote targets even without a local browser and honors explicit local routing', async () => {
  state.browsers.mockReturnValue([]);
  state.config = { server: 'wss://configured.example' };
  expect(await readHelpCapabilities(['--help'])).toEqual(catalog);
  expect(state.options).toHaveBeenLastCalledWith(expect.objectContaining({ serverUrl: 'wss://configured.example' }));
  state.invoke.mockClear();
  expect(await readHelpCapabilities(['--help', '--local'])).toBeUndefined();
  expect(state.invoke).not.toHaveBeenCalled();
  state.browsers.mockReturnValue([{}]);
  await readHelpCapabilities(['--help', '--local']);
  expect(state.invoke).toHaveBeenLastCalledWith('get_capabilities', {}, { local: true });
});
it('shares the normal CLI explicit, environment and file server precedence', async () => {
  state.config = { server: 'wss://configured.example' };
  vi.stubEnv('MEARL_SERVER_URL', 'wss://environment.example');
  await readHelpCapabilities(['--help']);
  expect(state.options).toHaveBeenLastCalledWith(expect.objectContaining({ serverUrl: 'wss://environment.example' }));
  await readHelpCapabilities(['--help', '--server', 'wss://explicit.example']);
  expect(state.options).toHaveBeenLastCalledWith(expect.objectContaining({ serverUrl: 'wss://explicit.example' }));
});
