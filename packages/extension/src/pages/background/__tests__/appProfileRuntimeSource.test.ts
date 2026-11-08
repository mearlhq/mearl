import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_PROFILE_RUNTIME_ASSET,
  APP_PROFILE_RUNTIME_INSTALLER,
} from '../../../shared/appProfileRuntimeAsset';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';

const registry = vi.hoisted(() => ({ pageRuntimeSource: vi.fn() }));
vi.mock('../browserCapabilityRegistry', () => ({ browserCapabilityRegistry: () => registry }));

describe('包内 App profile 运行时源码', () => {
  const fetchAsset = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    fetchAsset.mockReset();
    registry.pageRuntimeSource.mockReset();
    vi.stubGlobal('fetch', fetchAsset);
    chrome.runtime.getURL = vi.fn(path => `chrome-extension://runtime-test/${path}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>)[APP_PROFILE_RUNTIME_INSTALLER];
    delete (window as unknown as Record<string, unknown>).__mearlPageRuntimeHost__;
  });

  it('并发请求和后续请求共用同一次包内资源读取', async () => {
    fetchAsset.mockResolvedValue(new Response('/* runtime source */'));
    const { loadAppProfileRuntimeSource } = await import('../appProfileRuntimeSource');

    expect(
      await Promise.all([loadAppProfileRuntimeSource(), loadAppProfileRuntimeSource()]),
    ).toEqual(['/* runtime source */', '/* runtime source */']);
    await loadAppProfileRuntimeSource();

    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(fetchAsset).toHaveBeenCalledWith(
      `chrome-extension://runtime-test/${APP_PROFILE_RUNTIME_ASSET}`,
    );
  });

  it.each([new Response('', { status: 404 }), new Response('  ')])(
    '读取失败后允许重试',
    async response => {
      fetchAsset
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(new Response('retry source'));
      const { loadAppProfileRuntimeSource } = await import('../appProfileRuntimeSource');

      await expect(loadAppProfileRuntimeSource()).rejects.toThrow();
      await expect(loadAppProfileRuntimeSource()).resolves.toBe('retry source');
      expect(fetchAsset).toHaveBeenCalledTimes(2);
    },
  );

  it('CDP 源码先安装运行时再同步传入配置，不需要页面读取资源', async () => {
    fetchAsset.mockResolvedValue(
      new Response(
        `window[${JSON.stringify(APP_PROFILE_RUNTIME_INSTALLER)}] = config => { window.__runtimeTestConfig = config; };`,
      ),
    );
    const { buildAppProfileRuntimeCallSource } = await import('../appProfileRuntimeSource');
    const source = await buildAppProfileRuntimeCallSource('config');

    window.eval(`(() => { const config = { profile: 'test' }; ${source} })();`);
    expect((window as unknown as Record<string, unknown>).__runtimeTestConfig).toEqual({
      profile: 'test',
    });
    delete (window as unknown as Record<string, unknown>).__runtimeTestConfig;
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('import(');
  });
  it('uses the pinned local package installer without fetching or executing the bundled fallback', async () => {
    registry.pageRuntimeSource.mockResolvedValue(
      'module.exports.install=config=>{window.__runtimeTestConfig=config;};',
    );
    const config = {
      ...resolveAppProfile('reader').injected,
      pageRuntime: { id: 'simulation/main', sha256: 'a'.repeat(64) },
    };
    const { buildAppProfileRuntimeProgram } = await import('../appProfileRuntimeSource');
    const program = await buildAppProfileRuntimeProgram('config', config);
    expect((window as unknown as Record<string, unknown>).__runtimeTestConfig).toBeUndefined();
    window.eval(
      `(() => { const config = ${JSON.stringify(config)}; ${program.registration}${program.call} })();`,
    );
    expect((window as unknown as Record<string, unknown>).__runtimeTestConfig).toEqual(config);
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(registry.pageRuntimeSource).toHaveBeenCalledWith(config.pageRuntime.sha256);
    delete (window as unknown as Record<string, unknown>).__runtimeTestConfig;
  });
  it('fails a missing pinned source instead of silently selecting a bundled implementation', async () => {
    registry.pageRuntimeSource.mockRejectedValue(new Error('Pinned source unavailable'));
    const config = {
      ...resolveAppProfile('reader').injected,
      pageRuntime: { id: 'simulation/main', sha256: 'b'.repeat(64) },
    };
    const { buildAppProfileRuntimeProgram } = await import('../appProfileRuntimeSource');
    await expect(buildAppProfileRuntimeProgram('config', config)).rejects.toThrow(
      'Pinned source unavailable',
    );
    expect(fetchAsset).not.toHaveBeenCalled();
  });
});
