import { createContext, runInContext, runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { installAppProfileDocumentEnvironment, installAppProfileWhenDocumentReady } from '../environment/document.js';
import { resolveAppProfile } from './fixtures.js';

function page() {
  const callbacks: Array<() => void> = [];
  const observers: Array<{ disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }> = [];
  const document: { documentElement?: { style: { setProperty: ReturnType<typeof vi.fn> } }; body?: object } = {};
  const context = {
    navigator: { userAgent: 'Native', platform: 'Host', vendor: 'Native vendor', language: 'en-US', languages: ['en-US'] },
    document,
    MutationObserver: class {
      disconnect = vi.fn(); observe = vi.fn();
      constructor(callback: () => void) { callbacks.push(callback); observers.push(this); }
    },
  };
  const root = () => { document.documentElement = { style: { setProperty: vi.fn() } }; return document.documentElement; };
  return { context, document, callbacks, observers, root };
}

describe('serialized App document environment', () => {
  it('keeps a basic App limited to navigator identity and its restoration hint', () => {
    const f = page(), config = resolveAppProfile('shop').injected;
    config.globals = { ExampleBridge: 'must not install' };
    runInNewContext(`(${installAppProfileDocumentEnvironment.toString()})(${JSON.stringify(config)}, {globals:'runtime',restoreHintName:'__ownedHint__'})`, f.context);
    expect(f.context.navigator.userAgent).toBe(config.userAgent);
    expect(f.context.navigator.platform).toBe(config.navigatorPlatform);
    expect(f.context.navigator.vendor).toBe('Native vendor');
    expect(f.context.navigator.language).toBe('en-US');
    expect((f.context as any).ExampleBridge).toBeUndefined();
    expect((f.context as any).__STATUS_BAR_HEIGHT__).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(f.context, '__ownedHint__')).toMatchObject({ value: true, enumerable: false, configurable: true });
    expect(f.observers).toHaveLength(0);
  });

  it.each(['always', 'runtime'] as const)('installs full App globals and declared language (%s)', globals => {
    const f = page(), config = resolveAppProfile('wallet').injected;
    config.pageRuntime = { id: 'fixture/runtime', sha256: 'a'.repeat(64) };
    config.globals = { __APP_NAME__: 'Fixture' };
    runInNewContext(`(${installAppProfileDocumentEnvironment.toString()})(${JSON.stringify(config)}, ${JSON.stringify({ globals })})`, f.context);
    expect((f.context as any).__APP_NAME__).toBe('Fixture');
    expect((f.context as any).__STATUS_BAR_HEIGHT__).toBe(config.statusBarHeight);
    expect(f.context.navigator.vendor).toBe('Apple Computer, Inc.');
    expect(f.context.navigator.language).toBe(config.language);
    expect(f.context.navigator.languages).toEqual([config.language]);
  });

  it('uses the real browser properties when a page declares same-named lexical variables', () => {
    const f = page(), config = resolveAppProfile('shop').injected, install = vi.fn();
    f.root(); f.document.body = {};
    const context = createContext({ ...f.context, install });
    runInContext('let navigator = {}; let document = {}; let MutationObserver = null;', context);
    runInContext(`(${installAppProfileDocumentEnvironment.toString()})(${JSON.stringify(config)}, {globals:'always',safeAreaVariables:true}); (${installAppProfileWhenDocumentReady.toString()})(install, true);`, context);
    expect(f.context.navigator.userAgent).toBe(config.userAgent);
    expect(f.document.documentElement!.style.setProperty).toHaveBeenCalledTimes(4);
    expect(install).toHaveBeenCalledOnce();
    expect(runInContext('navigator.userAgent', context)).toBeUndefined();
  });

  it('preserves frozen globals and navigator fields while installing other fields', () => {
    const f = page(), config = resolveAppProfile('shop').injected;
    Object.defineProperty(f.context.navigator, 'userAgent', { value: 'Protected', configurable: false });
    Object.defineProperty(f.context, 'Example', { value: 'Protected', configurable: false, writable: false });
    config.globals = { Example: 'Replacement', Other: 'Available' };
    runInNewContext(`(${installAppProfileDocumentEnvironment.toString()})(${JSON.stringify(config)}, {globals:'always'})`, f.context);
    expect(f.context.navigator.userAgent).toBe('Protected');
    expect(f.context.navigator.platform).toBe(config.navigatorPlatform);
    expect((f.context as any).Example).toBe('Protected');
    expect((f.context as any).Other).toBe('Available');
  });

  it('defers safe-area variables until the document root appears and disconnects', () => {
    const f = page(), config = resolveAppProfile('shop').injected;
    config.safeAreaInsets = { top: 11, right: 2, bottom: 9, left: 4 };
    runInNewContext(`(${installAppProfileDocumentEnvironment.toString()})(${JSON.stringify(config)}, {globals:'always',safeAreaVariables:true})`, f.context);
    expect(f.observers[0]!.observe).toHaveBeenCalledWith(f.document, { childList: true });
    f.callbacks[0]!();
    expect(f.observers[0]!.disconnect).not.toHaveBeenCalled();
    const root = f.root(); f.callbacks[0]!();
    expect(root.style.setProperty.mock.calls).toEqual([
      ['--safe-area-inset-top', '11px'], ['--safe-area-inset-right', '2px'],
      ['--safe-area-inset-bottom', '9px'], ['--safe-area-inset-left', '4px'],
    ]);
    expect(f.observers[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it.each([false, true])('waits for the required DOM nodes before starting the runtime (body=%s)', waitForBody => {
    const f = page(), install = vi.fn();
    runInNewContext(`(${installAppProfileWhenDocumentReady.toString()})(install, ${waitForBody})`, { ...f.context, install });
    expect(install).not.toHaveBeenCalled();
    expect(f.observers[0]!.observe).toHaveBeenCalledWith(f.document, { childList: true, subtree: waitForBody });
    f.root(); f.callbacks[0]!();
    if (waitForBody) { expect(install).not.toHaveBeenCalled(); f.document.body = {}; f.callbacks[0]!(); }
    expect(install).toHaveBeenCalledOnce();
    expect(f.observers[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it('starts immediately on a ready document without allocating an observer', () => {
    const f = page(), install = vi.fn(); f.root(); f.document.body = {};
    runInNewContext(`(${installAppProfileWhenDocumentReady.toString()})(install, true)`, { ...f.context, install });
    expect(install).toHaveBeenCalledOnce(); expect(f.observers).toHaveLength(0);
  });
});
