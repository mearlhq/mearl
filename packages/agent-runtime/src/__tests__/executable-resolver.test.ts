import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  agentExecutableCandidatePaths,
  AgentExecutableResolver,
  executableFileCandidates,
} from '../executable-resolver.js';

describe('AgentExecutableResolver', () => {
  it('keeps unique executable files in candidate order', () => {
    expect(
      executableFileCandidates([
        undefined,
        process.execPath,
        process.execPath,
        path.dirname(process.execPath),
        path.join(path.dirname(process.execPath), 'missing-agent-cli'),
      ]),
    ).toEqual([process.execPath]);
  });

  it('builds shared user, version-manager, system, and PATH candidates in priority order', () => {
    const directory = (name: string, isDirectory = true) => ({
      name,
      isDirectory: () => isDirectory,
    });
    const readdirSync = vi.fn((root: string) => {
      if (root === '/home/test/.nvm/versions/node') {
        return [directory('v20.19.5'), directory('v25.0.0'), directory('current', false)];
      }
      if (root === '/home/test/.local/share/fnm/node-versions') {
        return [directory('v22.14.0')];
      }
      throw new Error('unexpected directory');
    }) as unknown as typeof import('node:fs').readdirSync;

    const candidates = agentExecutableCandidatePaths({
      executableNames: ['agent'],
      configuredPath: '/configured/agent',
      env: { PATH: '/terminal/bin:/usr/bin' },
      extraUserCandidates: ['/provider/managed/agent'],
      home: '/home/test',
      platform: 'linux',
      processExecPath: '/current-node/bin/node',
      readdirSync,
    });

    expect(candidates[0]).toBe('/configured/agent');
    expect(candidates[1]).toBe('/current-node/bin/agent');
    expect(candidates).toContain('/home/test/.local/share/pnpm/agent');
    expect(candidates).toContain('/provider/managed/agent');
    expect(candidates).toContain('/home/test/.nvm/versions/node/v25.0.0/bin/agent');
    expect(candidates).toContain(
      '/home/test/.local/share/fnm/node-versions/v22.14.0/installation/bin/agent',
    );
    expect(candidates.indexOf('/home/test/.nvm/versions/node/v25.0.0/bin/agent')).toBeLessThan(
      candidates.indexOf('/usr/local/bin/agent'),
    );
    expect(candidates.indexOf('/usr/local/bin/agent')).toBeLessThan(
      candidates.indexOf('/terminal/bin/agent'),
    );
  });

  it('shares concurrent probes and caches a usable executable', async () => {
    let finishProbe: ((error: string | null) => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<string | null>(resolve => {
          finishProbe = resolve;
        }),
    );
    const resolver = new AgentExecutableResolver({
      candidates: () => [process.execPath],
      probe,
      notFoundError: 'not found',
      unusableError: 'not usable',
    });

    const first = resolver.resolve();
    const second = resolver.resolve();
    expect(probe).toHaveBeenCalledOnce();
    finishProbe?.(null);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { executable: process.execPath, error: null },
      { executable: process.execPath, error: null },
    ]);
    await expect(resolver.resolve()).resolves.toEqual({
      executable: process.execPath,
      error: null,
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('does not restore a cached executable after being reset during a probe', async () => {
    let finishProbe: ((error: string | null) => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<string | null>(resolve => {
          finishProbe = resolve;
        }),
    );
    const resolver = new AgentExecutableResolver({
      candidates: () => [process.execPath],
      probe,
      notFoundError: 'not found',
      unusableError: 'not usable',
    });

    const resolution = resolver.resolve();
    resolver.reset();
    finishProbe?.(null);
    await resolution;

    const nextResolution = resolver.resolve();
    expect(probe).toHaveBeenCalledTimes(2);
    finishProbe?.(null);
    await nextResolution;
  });

  it('selects the newest compatible executable when versions are available', async () => {
    const probe = vi.fn().mockResolvedValue(null);
    const getVersion = vi.fn(async (executable: string) =>
      executable === '/app/codex' ? '0.157.0-alpha.1' : '0.156.1',
    );
    const resolver = new AgentExecutableResolver({
      candidates: () => ['/cli/codex', '/app/codex'],
      probe,
      getVersion,
      compareVersions: (left, right) => left.localeCompare(right, undefined, { numeric: true }),
      notFoundError: 'not found',
      unusableError: 'not usable',
    });

    await expect(resolver.resolve()).resolves.toEqual({
      executable: '/app/codex',
      error: null,
    });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(getVersion).toHaveBeenCalledTimes(2);
  });

  it('uses an explicitly preferred executable without inspecting automatic candidates', async () => {
    const probe = vi.fn().mockResolvedValue(null);
    const getVersion = vi.fn().mockResolvedValue('0.999.0');
    const resolver = new AgentExecutableResolver({
      candidates: () => ['/configured/codex', '/automatic/codex'],
      probe,
      getVersion,
      preferred: executable => executable === '/configured/codex',
      notFoundError: 'not found',
      unusableError: 'not usable',
    });

    await expect(resolver.resolve()).resolves.toEqual({
      executable: '/configured/codex',
      error: null,
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith('/configured/codex');
    expect(getVersion).not.toHaveBeenCalled();
  });
});
