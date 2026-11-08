import { describe, expect, it, vi } from 'vitest';
import { createExtensionBrowserNameResolver, detectNativeBrowserName } from '../browser-identity.js';

function probe(identifier = 'com.citrolabs.ego.lite') {
  return {
    platform: 'darwin' as NodeJS.Platform,
    parentPid: 123,
    executable: vi.fn(() => '/Applications/Renamed Browser.app/Contents/MacOS/browser'),
    bundleIdentifier: vi.fn(() => identifier),
  };
}

describe('Native Messaging browser identity', () => {
  it.each([
    ['com.citrolabs.ego.lite', 'EgoLite'],
    ['com.google.Chrome', 'Chrome'],
    ['com.microsoft.edgemac', 'Edge'],
    ['com.google.Chrome.canary', 'Chrome Canary'],
    ['com.microsoft.edgemac.Beta', 'Edge Beta'],
  ])('identifies %s by its bundle ID even when the app was renamed', (identifier, name) => {
    const input = probe(identifier);
    expect(detectNativeBrowserName(input)).toBe(name);
    expect(input.executable).toHaveBeenCalledExactlyOnceWith(123);
    expect(input.bundleIdentifier).toHaveBeenCalledExactlyOnceWith(
      '/Applications/Renamed Browser.app/Contents/Info.plist',
    );
  });

  it('does not infer Chrome from an app directory name', () => {
    const input = probe('example.unknown.browser');
    input.executable.mockReturnValue('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(detectNativeBrowserName(input)).toBeUndefined();
  });

  it('does not mistake a helper bundle for the browser application', () => {
    const input = probe('com.google.Chrome.helper');
    input.executable.mockReturnValue(
      '/Applications/Google Chrome.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper',
    );
    expect(detectNativeBrowserName(input)).toBeUndefined();
    expect(input.bundleIdentifier).toHaveBeenCalledWith(
      '/Applications/Google Chrome.app/Contents/Frameworks/Helper.app/Contents/Info.plist',
    );
  });

  it.each(['linux', 'win32'] as const)('preserves fallback without probing on %s', platform => {
    const input = { ...probe(), platform };
    expect(detectNativeBrowserName(input)).toBeUndefined();
    expect(input.executable).not.toHaveBeenCalled();
  });

  it.each([0, 1, -1, NaN, 1.5])('does not probe invalid parent PID %s', parentPid => {
    const input = { ...probe(), parentPid };
    expect(detectNativeBrowserName(input)).toBeUndefined();
    expect(input.executable).not.toHaveBeenCalled();
  });

  it.each(['/usr/bin/node', 'relative.app/Contents/MacOS/browser', '/App.app/Contents/MacOS/a\nb'])(
    'ignores non-app or malformed executable %s', executable => {
      const input = probe();
      input.executable.mockReturnValue(executable);
      expect(detectNativeBrowserName(input)).toBeUndefined();
      expect(input.bundleIdentifier).not.toHaveBeenCalled();
    },
  );

  it.each(['executable', 'bundleIdentifier'] as const)('tolerates failed or timed-out %s reads', stage => {
    const input = probe();
    input[stage].mockImplementation(() => { throw new Error('inspection unavailable'); });
    expect(detectNativeBrowserName(input)).toBeUndefined();
  });

  it('caches browser identity independently of page UA and reconnect reports', () => {
    const detect = vi.fn(() => 'EgoLite');
    const resolve = createExtensionBrowserNameResolver(detect);
    expect(resolve('Chrome')).toBe('EgoLite');
    expect(resolve('Safari')).toBe('EgoLite');
    expect(detect).toHaveBeenCalledOnce();
  });

  it('caches unavailable inspection while retaining each reported fallback', () => {
    const detect = vi.fn(() => undefined);
    const resolve = createExtensionBrowserNameResolver(detect);
    expect(resolve('Chrome')).toBe('Chrome');
    expect(resolve('Edge')).toBe('Edge');
    expect(detect).toHaveBeenCalledOnce();
  });
});
