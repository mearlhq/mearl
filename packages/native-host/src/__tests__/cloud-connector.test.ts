import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { OFFICIAL_NPM_REGISTRY } from '@mearl/setup/npm-registry';
import { initCloudConnector, startCloudConnector } from '../cloud-connector.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('@mearl/daemon-core', async importOriginal => ({
  ...(await importOriginal<typeof import('@mearl/daemon-core')>()),
  isAlive: () => false,
  keyedDir: () => '/unused/connectors',
  keyedConfigFile: () => '/unused/connector.json',
  readRecord: () => null,
  removeRecordIfPid: vi.fn(),
  readLiveRecords: () => [],
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it('uses the same official registry for global install and its npx fallback', async () => {
  vi.stubEnv('npm_config_registry', 'https://mirror.example/');
  vi.stubEnv('npm_config_package', '@mearl/client@3.0.0');
  vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as ReturnType<
    typeof spawnSync
  >);
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  initCloudConnector({
    log: vi.fn(),
    isDaemonMode: true,
    sendToExtension: vi.fn(),
    version: '2.20.0',
  });
  const result = startCloudConnector('wss://cloud.example/');
  child.emit('error', new Error('test process unavailable'));
  await expect(result).resolves.toMatchObject({ success: false });

  const installCall = vi.mocked(spawnSync).mock.calls.find(([, args]) => args?.[0] === 'install');
  expect(installCall?.[1]).toEqual([
    'install',
    '-g',
    '@mearl/cloud-connector@2.20.0',
    '--prefer-offline',
  ]);
  expect(installCall?.[2]?.env?.npm_config_registry).toBe(OFFICIAL_NPM_REGISTRY);
  expect(spawn).toHaveBeenCalledWith(
    expect.stringMatching(/npx(?:\.cmd)?$/),
    ['@mearl/cloud-connector@2.20.0', 'wss://cloud.example/', '--fail-fast'],
    expect.objectContaining({
      env: expect.objectContaining({ npm_config_registry: OFFICIAL_NPM_REGISTRY }),
    }),
  );
  expect(process.env.npm_config_registry).toBe('https://mirror.example/');
  expect(vi.mocked(spawn).mock.calls[0][2]?.env).not.toHaveProperty('npm_config_package');
});
