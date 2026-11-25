import { beforeEach, expect, it, vi } from 'vitest';
import { ProviderTaskExtension } from '../provider-task-extension.js';
import { ControlSessionRegistry } from '../control-session.js';
import { browserConnectionIdentity, type BrowserRecord } from '../browser-registry.js';
import type { ExtensionBrowserProvider } from '../builtin-providers/extension.js';

const { socket, browsers, host } = vi.hoisted(() => ({
  socket: vi.fn(),
  browsers: vi.fn(),
  host: vi.fn(),
}));
vi.mock('../browser-socket-request.js', () => ({ requestBrowserSocket: socket }));
vi.mock('../browser-registry.js', async original => ({
  ...(await original<typeof import('../browser-registry.js')>()),
  listRegisteredBrowsers: browsers,
}));
vi.mock('@mearl/provider/host', () => ({ readProviderControlHost: host }));

const task: BrowserRecord = {
  browserId: 'provider:fixture:task',
  browserName: 'Fixture Task',
  pid: 10,
  socketPath: '/provider.sock',
  transport: 'provider',
  providerBrowserId: 'task',
  status: 'connected',
  startedAt: 'now',
  updatedAt: 0,
  details: { taskSessionScope: 'session' },
};
const request = {
  providerControlToken: 'token',
  providerTarget: task.browserId,
  providerPageId: 2,
  providerSourceIdentity: browserConnectionIdentity(task),
  controlSource: 'remote',
};
const operation = {
  operation: 'invoke',
  action: 'page_click',
  data: { tabId: 2, selector: 'button' },
} as const;
function createBridge(extension: Partial<ExtensionBrowserProvider>) {
  const registry = new ControlSessionRegistry(() => 'extension-profile');
  return {
    registry,
    bridge: new ProviderTaskExtension(extension as ExtensionBrowserProvider, registry),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  browsers.mockReturnValue([task]);
  host.mockReturnValue({ ready: true, token: 'token', taskSessionProtocolVersion: 1 });
  socket.mockResolvedValue({ tabId: 2, ready: true, targetId: 'target-a', url: 'about:blank' });
});

it('matches the same native page and forwards the selected extension tab under the original authorization source', async () => {
  const extension = {
    request: vi
      .fn()
      .mockResolvedValueOnce({ tabId: 77 })
      .mockResolvedValueOnce({ tabId: 77 })
      .mockResolvedValueOnce({ tabId: 77, observation: { openedTabs: [{ tabId: 78 }] } }),
  };
  const { bridge } = createBridge(extension as unknown as ExtensionBrowserProvider);
  const response = await bridge.dispatch({ ...request, data: operation });
  expect(extension.request.mock.calls[2]).toEqual([
    'page_click',
    { tabId: 77, selector: 'button', __mearlExpectedTargetId: 'target-a' },
    expect.any(Number),
    true,
    'remote',
  ]);
  expect(response).toEqual({ tabId: 2, observation: { openedTabs: [] } });
  expect(socket).toHaveBeenCalledTimes(2);
});

it('blocks dispatch when the native owner hands off or the caller cannot prove the scope', async () => {
  const extension = { request: vi.fn().mockResolvedValue({ tabId: 77 }) };
  const { bridge } = createBridge(extension as unknown as ExtensionBrowserProvider);
  await expect(
    bridge.dispatch({ ...request, providerControlToken: 'invalid', data: operation }),
  ).rejects.toThrow('Invalid Provider task');
  expect(extension.request).not.toHaveBeenCalled();
  socket
    .mockResolvedValueOnce({ tabId: 2, ready: true, targetId: 'target-a', url: 'about:blank' })
    .mockResolvedValueOnce({ tabId: 2, ready: false });
  await expect(bridge.dispatch({ ...request, data: operation })).rejects.toThrow(
    'EXTERNAL_CONTROL_PAUSED',
  );
  expect(extension.request).toHaveBeenCalledTimes(1);
});

it('checks extension authorization for a destination before a task page exists', async () => {
  const extension = { request: vi.fn().mockResolvedValue({ authorized: true }) };
  const { bridge } = createBridge(extension as unknown as ExtensionBrowserProvider);
  const url = 'https://example.test';
  const data = { operation: 'authorize_open', url } as const;
  await expect(bridge.dispatch({ ...request, providerPageId: undefined, data })).resolves.toEqual({
    authorized: true,
  });
  expect(extension.request).toHaveBeenCalledWith(
    '__provider_task_authorize_open',
    { url },
    expect.any(Number),
    true,
    'remote',
  );
  expect(socket).not.toHaveBeenCalled();
});

it('reserves matched tabs against the ordinary extension route through native handoff and cleans retained pages', async () => {
  const extension = {
    request: vi.fn().mockResolvedValue({ tabId: 77 }),
    deactivate: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
  };
  const { bridge, registry } = createBridge(extension as unknown as ExtensionBrowserProvider);
  await bridge.dispatch({ ...request, data: { operation: 'reserve' } });
  expect(registry.list()).toEqual([]);
  expect(registry.internalTabs()).toEqual([77]);
  const run = (tabId: number) =>
    registry.run(undefined, 'page_click', { tabId }, async () => 'clicked');
  await expect(run(77)).rejects.toThrow('TAB_CONTROLLED_BY_SESSION');
  await expect(run(81)).resolves.toBe('clicked');
  await bridge.dispatch({
    ...request,
    providerPageId: undefined,
    data: { operation: 'deactivate' },
  });
  expect(extension.deactivate).toHaveBeenCalledWith([77]);
  await expect(run(77)).rejects.toThrow('TAB_CONTROLLED_BY_SESSION');
  await bridge.dispatch({
    ...request,
    providerPageId: undefined,
    data: { operation: 'cleanup', preserveEnvironment: true, returningToAgent: false },
  });
  expect(extension.cleanup).toHaveBeenCalledExactlyOnceWith([77], true, false);
  browsers.mockReturnValue([]);
  await bridge.prune();
  await expect(run(77)).resolves.toBe('clicked');
});

it('leaves the extension tab available if the native target changes before the queued proof', async () => {
  const { bridge, registry } = createBridge({ request: vi.fn().mockResolvedValue({ tabId: 77 }) });
  socket
    .mockResolvedValueOnce({ tabId: 2, ready: true, targetId: 'target-a', url: 'about:blank' })
    .mockResolvedValueOnce({ tabId: 2, ready: true, targetId: 'target-b', url: 'about:blank' });
  await expect(bridge.dispatch({ ...request, data: { operation: 'reserve' } })).rejects.toThrow(
    'PAGE_IDENTITY_CHANGED',
  );
  expect(registry.internalTabs()).toEqual([]);
  await expect(
    registry.run(undefined, 'page_snapshot', { tabId: 77 }, async () => 'available'),
  ).resolves.toBe('available');
});

it.each(['reserve', 'invoke'] as const)(
  'does not claim a replacement extension tab on %s',
  async operationName => {
    const extension = { request: vi.fn().mockResolvedValueOnce({ tabId: 77 }) };
    const { bridge, registry } = createBridge(extension);
    if (operationName === 'reserve') extension.request.mockResolvedValueOnce({ tabId: 79 });
    else
      extension.request
        .mockResolvedValueOnce({ tabId: 77 })
        .mockRejectedValueOnce(
          new Error('PAGE_IDENTITY_CHANGED: the extension target was replaced'),
        );
    const data = operationName === 'reserve' ? { operation: 'reserve' as const } : operation;
    await expect(bridge.dispatch({ ...request, data })).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    expect(registry.internalTabs()).toEqual([]);
  },
);
