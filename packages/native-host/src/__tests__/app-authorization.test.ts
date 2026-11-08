import { beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('../native-capability-services.js', () => ({ nativeCapabilities: { get: (name: string) => hooks.get(name), requireCustom: (name: string) => { const hook = hooks.get(name); if (!hook) throw new Error('Required capability is not installed'); return hook; } } }));
import { startAppAuthorization, waitAppAuthorization, closeAppAuthorization } from '../app-authorization.js';
beforeEach(() => hooks.clear());

describe('authorization capability relay', () => {
  it('requires an installed controller and does not create a fallback pairing', async () => {
    await expect(startAppAuthorization('sample.authorization', {})).rejects.toThrow('not installed');
    await expect(closeAppAuthorization('missing')).resolves.toBeUndefined();
  });
  it('pins an authorization controller from start through result and cleanup across capability updates', async () => {
    const phase = vi.fn();
    const params = { appId: 'fixture', scopeNicks: ['profile'] };
    const first = { start: vi.fn(async (_value, progress) => { progress('installing'); return { browserId: 'provider:fixture:one', qrSvg: '<svg/>' }; }), wait: vi.fn(async () => ({ authCode: 'fixture-result' })), close: vi.fn(async () => {}) };
    const second = { ...first, wait: vi.fn(async () => ({ authCode: 'wrong-controller' })), close: vi.fn(async () => {}) };
    hooks.set('sample.authorization', () => first);
    await expect(startAppAuthorization('sample.authorization', params, phase)).resolves.toMatchObject({ browserId: 'provider:fixture:one' });
    hooks.set('sample.authorization', () => second);
    await expect(waitAppAuthorization('provider:fixture:one', params, phase)).resolves.toEqual({ authCode: 'fixture-result' });
    expect(first.wait).toHaveBeenCalledWith('provider:fixture:one', params, phase);
    expect(second.wait).not.toHaveBeenCalled();
    await closeAppAuthorization('provider:fixture:one');
    expect(first.close).toHaveBeenCalledOnce(); expect(second.close).not.toHaveBeenCalled();
    expect(phase).toHaveBeenCalledWith('installing');
  });
});
