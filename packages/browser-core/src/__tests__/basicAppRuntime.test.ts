import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildAppProfileRuntimeCallSource } from '../appProfileRuntime.js';

describe('basic UA runtime', () => {
  it('installs the configured UA, platform and touch points without App bridges or containers', () => {
    const page = { navigator: {}, window: {}, config: { userAgent: 'Mozilla/5.0 Example/3', navigatorPlatform: 'iPhone', maxTouchPoints: 5, globals: { SECRET: 'ignored' }, bridges: [{ global: 'SampleBridge' }] } };
    runInNewContext(buildAppProfileRuntimeCallSource('config'), page);
    expect(page.navigator).toMatchObject({ userAgent: 'Mozilla/5.0 Example/3', appVersion: '5.0 Example/3', platform: 'iPhone', maxTouchPoints: 5 });
    expect(page.window).toEqual({});
    page.config.userAgent = 'Mozilla/5.0 Example/4';
    runInNewContext(buildAppProfileRuntimeCallSource('config'), page);
    expect(page.navigator).toMatchObject({ userAgent: 'Mozilla/5.0 Example/4', appVersion: '5.0 Example/4' });
  });
  it('publishes the configured restoration identity without business globals', () => {
    const page = { navigator: {}, config: { profile: 'shop', userAgent: 'Sample/1', globals: { BUSINESS: 'unused' } } };
    runInNewContext(buildAppProfileRuntimeCallSource('config'), page);
    expect((page as any).__mearlAppProfile__).toBe('shop');
    expect((page as any).BUSINESS).toBeUndefined();
  });
  it('requires the host to resolve exact capability code before execution', () => {
    const page = { navigator: {}, config: { userAgent: 'Mozilla/5.0 Example/3', pageRuntime: { id: 'sample/main', sha256: 'a'.repeat(64) } } };
    expect(() => runInNewContext(buildAppProfileRuntimeCallSource('config'), page)).toThrow('bound page runtime');
    expect(page.navigator).toEqual({});
  });
});
