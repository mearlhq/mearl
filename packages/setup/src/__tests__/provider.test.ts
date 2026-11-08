import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { isAlive } from '@mearl/daemon-core';
import * as providerHost from '@mearl/provider/host';
import {
  installProviderPackage,
  parseProviderPackageSpec,
  uninstallProviderPackage,
  updateProviderPackage,
} from '../provider.js';
import { OFFICIAL_NPM_REGISTRY } from '../npmRegistry.js';

const manifest = {
  providerId: 'example-device',
  name: 'Example Device Provider',
  version: '0.2.0',
  protocolVersion: 1,
  browserType: { name: '真机', parameters: [] },
  packageName: '@example/mearl-provider-device',
  packageRoot: '/global/node_modules/@example/mearl-provider-device',
  entryPath: '/global/node_modules/@example/mearl-provider-device/dist/runtime.js',
};

describe('Provider package setup', () => {
  it('stops an installed package before replacing its files and keeps failures before the package command', async () => {
    const runCommand = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const stopProvider = vi.fn(async () => { throw new Error('provider is busy'); });
    await expect(installProviderPackage(manifest.packageName, {
      listProviders: () => [manifest], stopProvider, runCommand,
      resolveInvokingManager: () => ({ manager: 'npm', command: '/tools/npm' }),
    })).rejects.toThrow('provider is busy');
    expect(stopProvider).toHaveBeenCalledExactlyOnceWith(manifest.providerId);
    expect(runCommand).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['@mearl/provider-example', OFFICIAL_NPM_REGISTRY],
    ['@third-party/provider', 'https://private.example/'],
  ])('selects the download source for %s', async (packageName, registry) => {
    vi.stubEnv('npm_config_registry', 'https://private.example/');
    const runCommand = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await installProviderPackage(packageName, {
      existsSync: () => true,
      registerPackage: () => ({ ...manifest, packageName }),
      resolveInvokingManager: () => ({ manager: 'npm', command: '/tools/npm' }),
      resolvePackageRoot: async () => manifest.packageRoot,
      runCommand,
    });
    expect(runCommand).toHaveBeenCalledWith(
      '/tools/npm',
      ['install', '-g', `${packageName}@latest`],
      expect.objectContaining({ env: expect.objectContaining({ npm_config_registry: registry }) }),
    );
  });

  it('parses scoped package versions without confusing the scope separator', () => {
    expect(parseProviderPackageSpec('@example/mearl-provider-device@next')).toEqual({
      packageName: '@example/mearl-provider-device',
      target: 'next',
    });
    expect(parseProviderPackageSpec('mearl-provider-device')).toEqual({
      packageName: 'mearl-provider-device',
      target: 'latest',
    });
    expect(() => parseProviderPackageSpec('../local-provider')).toThrow('npm package name');
  });

  it('installs globally, resolves the package root, and registers package metadata', async () => {
    vi.stubEnv('npm_config_registry', 'https://registry.example.com/');
    const runCommand = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const registerPackage = vi.fn(() => manifest);

    await expect(
      installProviderPackage('@example/mearl-provider-device@next', {
        existsSync: () => true,
        registerPackage,
        resolveInvokingManager: () => ({ manager: 'npm', command: '/tools/npm' }),
        resolvePackageRoot: async () => manifest.packageRoot,
        runCommand,
      }),
    ).resolves.toEqual({ manifest, manager: 'npm' });

    expect(runCommand).toHaveBeenCalledWith(
      '/tools/npm',
      ['install', '-g', '@example/mearl-provider-device@next'],
      expect.objectContaining({
        env: expect.objectContaining({ npm_config_registry: 'https://registry.example.com/' }),
        tee: true,
      }),
    );
    expect(registerPackage).toHaveBeenCalledExactlyOnceWith(manifest.packageRoot);
  });

  it('updates the registered package with its original package manager', async () => {
    vi.stubEnv('npm_config_registry', 'https://registry.example.com/');
    const runCommand = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const stopProvider = vi.fn();
    const registerPackage = vi.fn(() => ({ ...manifest, version: '0.3.0' }));

    await updateProviderPackage('example-device', {
      listProviders: () => [manifest],
      registerPackage,
      resolvePackageManager: () => ({ manager: 'pnpm', command: '/tools/pnpm' }),
      runCommand,
      stopProvider,
    });

    expect(stopProvider).toHaveBeenCalledExactlyOnceWith('example-device');
    expect(runCommand).toHaveBeenCalledWith(
      '/tools/pnpm',
      ['add', '-g', '@example/mearl-provider-device@latest'],
      expect.objectContaining({
        env: expect.objectContaining({ npm_config_registry: 'https://registry.example.com/' }),
        tee: true,
      }),
    );
    expect(registerPackage).toHaveBeenCalledExactlyOnceWith(manifest.packageRoot);
  });

  it('removes registration only after the package manager succeeds', async () => {
    const unregisterProvider = vi.fn();
    const failedRunner = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'failed' });
    const dependencies = {
      listProviders: () => [manifest],
      resolvePackageManager: () => ({ manager: 'npm' as const, command: '/tools/npm' }),
      runCommand: failedRunner,
      stopProvider: vi.fn(),
      unregisterProvider,
    };

    await expect(uninstallProviderPackage('example-device', dependencies)).rejects.toThrow(
      '@example/mearl-provider-device uninstall failed',
    );
    expect(unregisterProvider).not.toHaveBeenCalled();

    failedRunner.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    await expect(uninstallProviderPackage('example-device', dependencies)).resolves.toEqual({
      manifest,
      manager: 'npm',
    });
    expect(unregisterProvider).toHaveBeenCalledExactlyOnceWith('example-device');
  });

  it('waits for Provider shutdown before removing package code and preserves registration on stop failure', async () => {
    const runCommand = vi.fn().mockResolvedValue({ code: 0 });
    const unregisterProvider = vi.fn();
    let stopped = false;
    const deps = {
      listProviders: () => [manifest],
      resolvePackageManager: () => ({ manager: 'npm' as const, command: '/tools/npm' }),
      runCommand,
      unregisterProvider,
      stopProvider: vi.fn(async () => {
        await Promise.resolve();
        stopped = true;
      }),
    };
    runCommand.mockImplementation(async () => {
      expect(stopped).toBe(true);
      return { code: 0 };
    });
    await uninstallProviderPackage('example-device', deps);
    deps.stopProvider.mockRejectedValueOnce(new Error('stop failed'));
    runCommand.mockClear();
    unregisterProvider.mockClear();
    await expect(uninstallProviderPackage('example-device', deps)).rejects.toThrow('stop failed');
    expect(runCommand).not.toHaveBeenCalled();
    expect(unregisterProvider).not.toHaveBeenCalled();
  });

  it('waits for the original process after its live record has disappeared', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 150)'], {
      stdio: 'ignore',
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    vi.spyOn(providerHost, 'readProviderStart').mockReturnValue(null);
    vi.spyOn(providerHost, 'readLiveProvider')
      .mockReturnValueOnce({ pid: child.pid } as never)
      .mockReturnValue(null);
    vi.spyOn(providerHost, 'stopProvider').mockReturnValue(true);
    const runCommand = vi.fn(async () => {
      expect(isAlive(child.pid)).toBe(false);
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      await uninstallProviderPackage('example-device', {
        listProviders: () => [manifest],
        resolvePackageManager: () => ({ manager: 'npm', command: '/tools/npm' }),
        runCommand,
        unregisterProvider: vi.fn(),
      });
      expect(runCommand).toHaveBeenCalledOnce();
    } finally {
      child.kill();
      await exited;
    }
  });

  it('retains package code and registration while a Provider is starting', async () => {
    vi.spyOn(providerHost, 'readProviderStart').mockReturnValue({ pid: process.pid } as never);
    const runCommand = vi.fn();
    const unregisterProvider = vi.fn();
    await expect(
      uninstallProviderPackage('example-device', {
        listProviders: () => [manifest],
        resolvePackageManager: () => ({ manager: 'npm', command: '/tools/npm' }),
        runCommand,
        unregisterProvider,
      }),
    ).rejects.toThrow('still starting');
    expect(runCommand).not.toHaveBeenCalled();
    expect(unregisterProvider).not.toHaveBeenCalled();
  });
});
