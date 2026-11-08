import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  detectCliPackage,
  detectGlobalPackage,
  resolveInvokingPackageManager,
} from '../packageManager.js';
import { ensurePluginRuntime, PLUGIN_RUNTIME_VERSION } from '../pluginRuntime.js';
import { OFFICIAL_NPM_REGISTRY } from '../npmRegistry.js';
import type { CommandRunner } from '@mearl/daemon-core';

vi.mock('../packageManager.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../packageManager.js')>()),
  detectCliPackage: vi.fn(),
  detectGlobalPackage: vi.fn(),
  resolveInvokingPackageManager: vi.fn(),
}));
let directory: string;
const installed = new Map<string, NonNullable<ReturnType<typeof detectCliPackage>>>();

function putPackage(name: string, version = PLUGIN_RUNTIME_VERSION, supportsPlugins = true) {
  const packageName = `@mearl/${name}`;
  const packageRoot = join(directory, name);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: packageName,
      version,
      ...(supportsPlugins ? { exports: { './plugin': { import: './plugin.js' } } } : {}),
    }),
  );
  writeFileSync(join(packageRoot, 'plugin.js'), '');
  installed.set(packageName, {
    packageName,
    packageRoot,
    executable: join(directory, name === 'client' ? 'mearl' : 'mearl-native-host'),
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-plugin-runtime-'));
  installed.clear();
  vi.mocked(detectCliPackage).mockImplementation(name => installed.get(name) ?? null);
  vi.mocked(detectGlobalPackage).mockReturnValue(null);
  vi.mocked(resolveInvokingPackageManager).mockReturnValue({ manager: 'npm', command: 'npm' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  putPackage('client');
  putPackage('native-host');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

it('keeps current and newer development links and initializes their skills host', async () => {
  const runner = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  await ensurePluginRuntime(runner);
  putPackage('client', '999.0.0');
  putPackage('native-host', '999.0.0-beta.1');
  await ensurePluginRuntime(runner);
  expect(runner.mock.calls).toEqual([
    [join(directory, 'mearl-native-host'), ['--init', '--mode', 'skills'], expect.any(Object)],
    [join(directory, 'mearl-native-host'), ['--init', '--mode', 'skills'], expect.any(Object)],
  ]);
});

it('updates only an old native host with its package manager, verifies it, then initializes skills mode', async () => {
  putPackage('native-host', '1.0.0');
  vi.mocked(detectGlobalPackage).mockReturnValue({
    ...installed.get('@mearl/native-host')!,
    manager: 'pnpm',
    command: '/tools/pnpm',
  });
  const runner = vi.fn(async () => {
    putPackage('native-host');
    return { code: 0, stdout: '', stderr: '' };
  });
  await ensurePluginRuntime(runner);
  expect(runner.mock.calls).toEqual([
    [
      '/tools/pnpm',
      ['add', '-g', `@mearl/native-host@${PLUGIN_RUNTIME_VERSION}`],
      expect.any(Object),
    ],
    [join(directory, 'mearl-native-host'), ['--init', '--mode', 'skills'], expect.any(Object)],
  ]);
});

it('installs missing components at the setup version and does not resolve latest remotely', async () => {
  installed.clear();
  const runner = vi.fn<CommandRunner>(async (_command, args) => {
    if (args[0] === 'install')
      putPackage(args[2].startsWith('@mearl/client@') ? 'client' : 'native-host');
    return { code: 0, stdout: '', stderr: '' };
  });
  await ensurePluginRuntime(runner);
  expect(runner.mock.calls.map(([, args]) => args)).toEqual([
    ['install', '-g', `@mearl/client@${PLUGIN_RUNTIME_VERSION}`],
    ['install', '-g', `@mearl/native-host@${PLUGIN_RUNTIME_VERSION}`],
    ['--init', '--mode', 'skills'],
  ]);
  for (const [, , options] of runner.mock.calls.slice(0, 2)) {
    expect(options?.env?.npm_config_registry).toBe(OFFICIAL_NPM_REGISTRY);
  }
});

it('repairs a current client without the plugin export', async () => {
  putPackage('client', PLUGIN_RUNTIME_VERSION, false);
  const runner = vi.fn(async () => {
    putPackage('client');
    return { code: 0, stdout: '', stderr: '' };
  });
  await ensurePluginRuntime(runner);
  expect(runner.mock.calls.map(([, args]) => args)).toEqual([
    ['install', '-g', `@mearl/client@${PLUGIN_RUNTIME_VERSION}`],
    ['--init', '--mode', 'skills'],
  ]);
});

it('does not downgrade a newer incompatible client', async () => {
  putPackage('client', '999.0.0', false);
  const runner = vi.fn();
  await expect(ensurePluginRuntime(runner)).rejects.toThrow('缺少插件入口');
  expect(runner).not.toHaveBeenCalled();
});

it('reports failed updates and a stale PATH after a successful installer exit', async () => {
  putPackage('client', '1.0.0');
  await expect(ensurePluginRuntime(vi.fn().mockResolvedValue({ code: 3 }))).rejects.toThrow(
    '安装失败',
  );
  await expect(ensurePluginRuntime(vi.fn().mockResolvedValue({ code: 0 }))).rejects.toThrow('PATH');
});

it('reports a native-host initialization failure', async () => {
  putPackage('native-host', '1.0.0');
  const runner = vi.fn(async (_command: string, args: string[]) => {
    putPackage('native-host');
    return { code: args[0] === '--init' ? 1 : 0, stdout: '', stderr: '' };
  });
  await expect(ensurePluginRuntime(runner)).rejects.toThrow('初始化失败');
});
