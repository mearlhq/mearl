import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, testHome } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  testHome: `/tmp/mearl-provider-launcher-${process.pid}`,
}));

vi.mock('node:os', () => ({
  homedir: () => testHome,
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { ensureInstalledProvidersRunning } from '../launcher.js';
import { MEARL_PROVIDER_PROTOCOL_VERSION } from '../types.js';
import { liveProviderFile } from '../registry.js';

const installedDir = join(testHome, '.mearl', 'providers', 'installed');
const liveDir = join(testHome, '.mearl', 'providers', 'live');

beforeEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  mkdirSync(installedDir, { recursive: true });
  mkdirSync(liveDir, { recursive: true });
  vi.useFakeTimers();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(testHome, { recursive: true, force: true });
});

describe('installed provider launcher', () => {
  it.each([false, true])('extends only external-control startup for its control-host prerequisite (%s)', async external => {
    const packageRoot = join(testHome, 'prerequisite-package');
    const entryPath = join(packageRoot, 'runtime.js');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(entryPath, 'export {};');
    writeFileSync(join(installedDir, 'fixture.json'), JSON.stringify({
      providerId: 'fixture', name: 'Fixture', version: '1.0.0',
      protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
      browserType: {
        name: 'Fixture', inputSchema: { type: 'object', properties: {} },
        ...(external ? { controlSessionModes: ['external'] } : {}),
      },
      packageName: 'fixture-package', packageRoot, entryPath,
    }));
    spawnMock.mockImplementation(() => {
      setTimeout(() => writeFileSync(liveProviderFile('fixture'), JSON.stringify({
        pid: process.pid, providerId: 'fixture', providerProtocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
      })), 3000);
      const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const result = ensureInstalledProvidersRunning(['fixture']);
    await vi.runAllTimersAsync();
    expect(await result).toEqual(external ? [] : [expect.stringContaining('within 2s')]);
  });
  it.each([undefined, MEARL_PROVIDER_PROTOCOL_VERSION - 1, MEARL_PROVIDER_PROTOCOL_VERSION])(
    'checks the running protocol %s even with an up-to-date installation',
    async providerProtocolVersion => {
      const packageRoot = join(testHome, 'live-package'),
        entryPath = join(packageRoot, 'runtime.js');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(entryPath, 'export {};');
      writeFileSync(
        join(installedDir, 'fixture.json'),
        JSON.stringify({
          providerId: 'fixture',
          name: 'Fixture',
          version: '1.0.0',
          protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
          browserType: { name: 'Fixture', inputSchema: { type: 'object', properties: {} } },
          packageName: 'fixture-package',
          packageRoot,
          entryPath,
        }),
      );
      writeFileSync(
        liveProviderFile('fixture'),
        JSON.stringify({ pid: process.pid, providerId: 'fixture', providerProtocolVersion }),
      );
      const warnings = await ensureInstalledProvidersRunning(['fixture']);
      expect(warnings).toEqual(
        providerProtocolVersion === MEARL_PROVIDER_PROTOCOL_VERSION
          ? []
          : [expect.stringContaining('PROVIDER_PROTOCOL_MISMATCH')],
      );
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );
  it('starts only selected providers and ignores unrelated broken installations', async () => {
    const packageRoot = join(testHome, 'selected-package'),
      entryPath = join(packageRoot, 'runtime.js');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(entryPath, 'export {};');
    writeFileSync(
      join(installedDir, 'selected.json'),
      JSON.stringify({
        providerId: 'selected',
        name: 'Selected',
        version: '1.0.0',
        protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        browserType: { name: 'Browser', inputSchema: { type: 'object', properties: {} } },
        packageName: 'test-selected',
        packageRoot,
        entryPath,
      }),
    );
    writeFileSync(
      join(installedDir, 'unrelated.json'),
      JSON.stringify({ providerId: 'unrelated', packageRoot: 'missing' }),
    );
    spawnMock.mockImplementation(() => {
      writeFileSync(
        liveProviderFile('selected'),
        JSON.stringify({
          pid: process.pid,
          providerId: 'selected',
          providerProtocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        }),
      );
      const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const result = ensureInstalledProvidersRunning(['selected']);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([entryPath]);
  });
  it('starts an installed on-demand provider and waits for its live record', async () => {
    const packageRoot = join(testHome, 'fixture-package');
    const entryPath = join(packageRoot, 'runtime.js');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(entryPath, 'export {};\n');
    writeFileSync(
      join(installedDir, 'fixture.json'),
      JSON.stringify({
        providerId: 'fixture',
        name: 'Fixture provider',
        version: '1.0.0',
        protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        browserType: {
          name: 'Fixture browser',
          inputSchema: { type: 'object', properties: {} },
        },
        packageName: '@example/provider-fixture',
        packageRoot,
        entryPath,
      }),
    );
    spawnMock.mockImplementation(() => {
      writeFileSync(
        liveProviderFile('fixture'),
        JSON.stringify({
          pid: process.pid,
          providerId: 'fixture',
          providerProtocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        }),
      );
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        unref: ReturnType<typeof vi.fn>;
      };
      child.pid = process.pid;
      child.unref = vi.fn();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    const resultPromise = ensureInstalledProvidersRunning();
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual([]);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [entryPath],
      expect.objectContaining({
        cwd: packageRoot,
        detached: true,
      }),
    );
  });

  it('reports an invalid manifest without executing it', async () => {
    writeFileSync(
      join(installedDir, 'invalid.json'),
      JSON.stringify({
        providerId: 'invalid',
        name: 'Invalid provider',
        version: '1.0.0',
        protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        browserType: {
          name: 'Invalid browser',
          inputSchema: { type: 'object', properties: {} },
        },
        packageName: '@example/provider-invalid',
        packageRoot: 'relative/package',
        entryPath: 'relative/package/runtime.js',
      }),
    );

    await expect(ensureInstalledProvidersRunning()).resolves.toEqual([
      'provider invalid: packageRoot must be an absolute path',
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports a missing package entry without breaking provider discovery', async () => {
    const packageRoot = join(testHome, 'malformed-package');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(installedDir, 'malformed.json'),
      JSON.stringify({
        providerId: 'malformed',
        name: 'Malformed provider',
        version: '1.0.0',
        protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        browserType: {
          name: 'Malformed browser',
          inputSchema: { type: 'object', properties: {} },
        },
        packageName: '@example/provider-malformed',
        packageRoot,
        entryPath: join(packageRoot, 'missing.js'),
      }),
    );

    await expect(ensureInstalledProvidersRunning()).resolves.toEqual([
      'provider malformed: entryPath does not exist or is not a file',
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('coalesces concurrent startup requests for the same provider', async () => {
    const packageRoot = join(testHome, 'fixture-package');
    const entryPath = join(packageRoot, 'runtime.js');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(entryPath, 'export {};\n');
    writeFileSync(
      join(installedDir, 'fixture.json'),
      JSON.stringify({
        providerId: 'fixture',
        name: 'Fixture provider',
        version: '1.0.0',
        protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        browserType: {
          name: 'Fixture browser',
          inputSchema: { type: 'object', properties: {} },
        },
        packageName: '@example/provider-fixture',
        packageRoot,
        entryPath,
      }),
    );
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        unref: ReturnType<typeof vi.fn>;
      };
      child.pid = process.pid;
      child.unref = vi.fn();
      queueMicrotask(() => child.emit('spawn'));
      setTimeout(() => {
        writeFileSync(
          liveProviderFile('fixture'),
          JSON.stringify({
            pid: process.pid,
            providerId: 'fixture',
            providerProtocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
          }),
        );
      }, 100);
      return child;
    });

    const first = ensureInstalledProvidersRunning();
    const second = ensureInstalledProvidersRunning();
    await vi.runAllTimersAsync();

    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
