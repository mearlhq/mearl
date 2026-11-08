import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceOfficialPluginCatalog } from '../officialPluginCatalog.js';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { ensureOfficialPluginRegistered } from '../officialPluginInstaller.js';
import { registerPlugin } from '../pluginRegistry.js';

interface MockChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  stderr: EventEmitter;
  stdout: EventEmitter;
}

let directory: string;
let entry: string;

function createChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.kill = vi.fn();
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-official-plugin-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  replaceOfficialPluginCatalog('a'.repeat(64), {
    identity: { description: 'Identity fixture', installArgs: ['https://example.com/skills', '--skill', 'identity-request', '--yes'], skill: 'identity-request' },
    headers: { description: 'Headers fixture', installArgs: ['https://example.com/skills', '--skill', 'headers-request', '--yes'], skill: 'headers-request' },
    accounts: { description: 'Account fixture', installArgs: ['https://example.com/skills', '--skill', 'accounts', '--yes'], skill: 'accounts', setup: 'team' },
  });
  entry = join(directory, 'skill', 'scripts', 'main.mjs');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, `export default app => app.command('whoami', () => ({}));`);
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('official plugin installer', () => {
  it('deduplicates concurrent installs and verifies the resulting registration', async () => {
    const progress = vi.fn();
    spawnMock.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => {
        registerPlugin('identity', entry);
        child.emit('exit', 0);
      });
      return child;
    });

    const first = ensureOfficialPluginRegistered('identity', progress);
    const second = ensureOfficialPluginRegistered('identity');

    expect(first).toBe(second);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['-y', '--@mearl:registry=https://registry.npmjs.org', expect.stringMatching(/^@mearl\/setup@/), 'plugin', 'ensure', 'identity'],
      { env: expect.any(Object), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    expect(progress.mock.calls.map(([message]) => message)).toEqual([
      '正在安装官方插件 identity...',
      '官方插件 identity 已安装。',
    ]);
    expect(existsSync(join(directory, 'registry', '.official-identity.install.lock'))).toBe(false);
  });

  it('surfaces setup failures and releases the installation lock for retries', async () => {
    vi.stubEnv('npm_config_package', '@mearl/client@3.0.0');
    vi.stubEnv('NPM_CONFIG_PACKAGE', '@mearl/client@3.0.0');
    vi.stubEnv('npm_config_registry', 'https://registry.example.com/');
    spawnMock.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('registry unavailable\n'));
        child.emit('exit', 7);
      });
      return child;
    });

    await expect(ensureOfficialPluginRegistered('identity')).rejects.toThrow(
      '安装官方插件 identity 失败 (exit 7): registry unavailable',
    );
    expect(existsSync(join(directory, 'registry', '.official-identity.install.lock'))).toBe(false);
    const environment = spawnMock.mock.calls[0][2].env;
    expect(environment).not.toHaveProperty('npm_config_package');
    expect(environment).not.toHaveProperty('NPM_CONFIG_PACKAGE');
    expect(environment.npm_config_registry).toBe('https://registry.example.com/');
    expect(process.env.npm_config_package).toBe('@mearl/client@3.0.0');
  });
});

it('rejects a completed automatic install after the selected catalog changes', async () => {
  spawnMock.mockImplementation(() => {
    const child = createChild();
    queueMicrotask(() => { registerPlugin('identity', entry); replaceOfficialPluginCatalog('b'.repeat(64), {}); child.emit('exit', 0); });
    return child;
  });
  await expect(ensureOfficialPluginRegistered('identity')).rejects.toThrow('CATALOG_SELECTION_CHANGED');
  expect(spawnMock).toHaveBeenCalledOnce();
});
