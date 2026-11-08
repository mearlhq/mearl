import { describe, expect, it } from 'vitest';
import { isProviderEnhancementTarget, matchesProviderEnhancementTarget, isEnhancementNavigationOrigin } from './browserEnhancement.js';

describe('external enhancement identity proof', () => {
  it('accepts only bounded initial device observations and credential-free HTTP origins', () => {
    const base = { tabId: 1, ready: true, targetId: 'target', url: 'https://example.test' };
    const device = { userAgent: 'Host', platform: 'Host', userAgentMetadata: null,
      screen: { width: 1920, height: 1080, deviceScaleFactor: 1, orientation: 'landscape-primary', angle: 0 },
      touchPoints: 0, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
    expect(isProviderEnhancementTarget({ ...base, initialEnvironment: { device } })).toBe(true);
    expect(isProviderEnhancementTarget({ ...base, initialEnvironment: { device, unrelatedSecret: 'must not forward' } })).toBe(false);
    expect(isProviderEnhancementTarget({ ...base, initialEnvironment: { device: { ...device, userAgent: 'x'.repeat(4097) } } })).toBe(false);
    expect(isProviderEnhancementTarget({ ...base, initialEnvironment: { device: { ...device, screen: {} } } })).toBe(false);
    for (const value of ['https://example.test', 'http://127.0.0.1:8080']) expect(isEnhancementNavigationOrigin(value)).toBe(true);
    for (const value of ['file:///tmp/', 'about:blank', 'https://user:secret@example.test', 'https://example.test/path?secret=1']) expect(isEnhancementNavigationOrigin(value)).toBe(false);
  });
  it('requires a bounded nonempty frame or target identity beyond URL', () => {
    const base = { tabId: 1, ready: true as const, url: 'https://example.test' };
    expect(isProviderEnhancementTarget(base)).toBe(false);
    expect(isProviderEnhancementTarget({ ...base, targetId: 'target' })).toBe(true);
    expect(isProviderEnhancementTarget({ ...base, mainFrameId: 'frame' })).toBe(true);
    expect(isProviderEnhancementTarget({ ...base, targetId: '', mainFrameId: 'frame' })).toBe(false);
    expect(isProviderEnhancementTarget({ ...base, targetId: 'x'.repeat(257) })).toBe(false);
    expect(matchesProviderEnhancementTarget({ ...base, mainFrameId: 'frame', targetId: 'target' }, { mainFrameId: 'frame', targetId: 'other' })).toBe(false);
    expect(matchesProviderEnhancementTarget({ ...base, targetId: 'target' }, { mainFrameId: 'frame', targetId: 'target' })).toBe(true);
  });
});
