import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestUiFixture as legacyBrowserRequestUi } from '../../../../test/fixtures/requestUi';
const mocks = vi.hoisted(() => ({ state: null as any, toast: vi.fn() }));
vi.mock('../../utils/browserRequestUiState', () => ({
  getBrowserRequestUiState: () => mocks.state,
}));
vi.mock('../../utils/toast', () => ({ showToast: mocks.toast }));
vi.mock('../../utils/i18n', () => ({ t: (key: string) => key }));
let ports: {
  name: string;
  disconnect: ReturnType<typeof vi.fn>;
  ready: () => void;
  closed: () => void;
}[];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  ports = [];
  mocks.state = { selected: { revision: 'old' }, definition: legacyBrowserRequestUi };
  chrome.runtime.connect = vi.fn(({ name }) => {
    let onMessage!: (message: unknown) => void, onDisconnect!: () => void;
    const port = {
      name,
      onMessage: {
        addListener: vi.fn(fn => {
          onMessage = fn;
        }),
      },
      onDisconnect: {
        addListener: vi.fn(fn => {
          onDisconnect = fn;
        }),
      },
      disconnect: vi.fn(() => onDisconnect()),
    };
    ports.push({
      name,
      disconnect: port.disconnect,
      ready: () => onMessage({ ready: true }),
      closed: () => onDisconnect(),
    });
    return port as any;
  });
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: any) => ({
    success: true,
    data: { id: message.data.id, definition: legacyBrowserRequestUi },
  }));
});
afterEach(() => vi.useRealTimers());
it('opens only after the lifetime port is ready, retains accepted metadata and reconnects the same lease after a worker restart', async () => {
  const { useRequestMetadataLogin } = await import('../useRequestMetadataLogin');
  const { result } = renderHook(() => useRequestMetadataLogin());
  let opening!: Promise<void>;
  act(() => {
    opening = result.current.openLoginModal();
  });
  await waitFor(() => expect(ports).toHaveLength(1));
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  await act(async () => {
    ports[0].ready();
    await opening;
  });
  expect(result.current.loginModalOpen).toBe(true);
  const id = ports[0].name.slice('browser-request-login:'.length).split(':')[0];
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ data: { operation: 'loginOpen', revision: 'old', id } }),
  );
  mocks.state = {
    selected: { revision: 'new' },
    definition: {
      ...legacyBrowserRequestUi,
      login: { ...legacyBrowserRequestUi.login, url: 'https://new.example.com/' },
    },
  };
  vi.useFakeTimers();
  act(() => ports[0].closed());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
    ports[1].ready();
  });
  expect(ports[1].name).toBe(ports[0].name);
  expect(result.current.loginDefinition?.login.url).toBe(legacyBrowserRequestUi.login.url);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  await act(async () => result.current.closeLoginModal());
  expect(result.current.loginModalOpen).toBe(false);
  expect(ports[1].disconnect).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(ports).toHaveLength(2);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ data: { operation: 'loginClose', id } }),
  );
});
it('cleans the prepared connection when provider selection changes before open acceptance', async () => {
  const { useRequestMetadataLogin } = await import('../useRequestMetadataLogin');
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
    success: false,
    error: 'The request UI provider changed',
  });
  const { result } = renderHook(() => useRequestMetadataLogin());
  let opening!: Promise<void>;
  act(() => {
    opening = result.current.openLoginModal();
  });
  await waitFor(() => expect(ports).toHaveLength(1));
  await act(async () => {
    ports[0].ready();
    await opening;
  });
  expect(result.current.loginModalOpen).toBe(false);
  expect(ports[0].disconnect).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenCalledWith('requestMetadataLoginOpenFailed', 'error');
});
