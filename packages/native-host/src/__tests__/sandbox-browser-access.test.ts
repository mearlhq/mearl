import { beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('../native-capability-services.js', () => ({ nativeCapabilities: { get: (name: string) => hooks.get(name), require: (name: string) => { const hook = hooks.get(name); if (!hook) throw new Error('Required capability is not installed'); return hook; } } }));
import { resolveSandboxBrowserAccess, resolveSandboxBrowserAccessCapability } from '../sandbox-browser-access.js';
beforeEach(() => hooks.clear());

describe('optional browser access capability', () => {
  it('has no deployment-specific discovery in the public core', async () => {
    expect(resolveSandboxBrowserAccessCapability()).toBeNull();
    await expect(resolveSandboxBrowserAccess()).rejects.toThrow('not installed');
  });
  it('keeps capability discovery separate from resolving the sensitive URL', async () => {
    const resolve = vi.fn(async () => ({ kind: 'fixture-stream', url: 'https://example.com/browser' }));
    hooks.set('browser.access.capability', () => ({ kind: 'fixture-stream' }));
    hooks.set('browser.access.resolve', resolve);
    expect(resolveSandboxBrowserAccessCapability()).toEqual({ kind: 'fixture-stream' }); expect(resolve).not.toHaveBeenCalled();
    await expect(resolveSandboxBrowserAccess()).resolves.toEqual({ kind: 'fixture-stream', url: 'https://example.com/browser' });
  });
});
