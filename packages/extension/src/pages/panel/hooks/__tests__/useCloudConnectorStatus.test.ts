import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCloudConnectorStatus } from '../useCloudConnectorStatus';

const serviceMocks = vi.hoisted(() => ({
  requestExtensionService: vi.fn(),
}));

vi.mock('../../../../shared/extensionServiceRequest', () => serviceMocks);

describe('useCloudConnectorStatus', () => {
  beforeEach(() => {
    serviceMocks.requestExtensionService.mockReset().mockResolvedValue({ connectors: [] });
  });

  it('does not query or start connectors while Agent service is disabled', async () => {
    const { result } = renderHook(() => useCloudConnectorStatus(false));

    expect(serviceMocks.requestExtensionService).not.toHaveBeenCalled();
    await expect(result.current.startConnector('wss://example.com')).resolves.toEqual({
      success: false,
      error: 'Agent service is disabled',
    });
    expect(serviceMocks.requestExtensionService).not.toHaveBeenCalled();
  });

  it('starts querying after Agent service is enabled', async () => {
    const { rerender } = renderHook(({ enabled }) => useCloudConnectorStatus(enabled), {
      initialProps: { enabled: false },
    });

    rerender({ enabled: true });
    await waitFor(() =>
      expect(serviceMocks.requestExtensionService).toHaveBeenCalledWith(
        'list_cloud_connectors',
        {},
      ),
    );
  });

  it('ignores a status response that arrives after Agent service is disabled', async () => {
    let resolveStatus: ((value: unknown) => void) | undefined;
    serviceMocks.requestExtensionService.mockReturnValueOnce(
      new Promise(resolve => {
        resolveStatus = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ enabled }) => useCloudConnectorStatus(enabled), {
      initialProps: { enabled: true },
    });

    await waitFor(() => expect(serviceMocks.requestExtensionService).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });
    await act(async () => {
      resolveStatus?.({
        connectors: [{ serverUrl: 'wss://example.com', name: 'work-mac', pid: 42 }],
      });
    });

    expect(result.current.state).toEqual({
      connected: false,
      serverUrl: null,
      name: null,
      pid: null,
    });
  });

  it('does not restore connection state when a start request finishes after disabling', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useCloudConnectorStatus(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(serviceMocks.requestExtensionService).toHaveBeenCalledTimes(1));

    let resolveStart: ((value: unknown) => void) | undefined;
    serviceMocks.requestExtensionService.mockReturnValueOnce(
      new Promise(resolve => {
        resolveStart = resolve;
      }),
    );
    let startRequest: Promise<{ success: boolean; error?: string }> | undefined;
    act(() => {
      startRequest = result.current.startConnector('wss://example.com');
    });
    expect(result.current.loading).toBe(true);

    rerender({ enabled: false });
    await act(async () => {
      resolveStart?.({ success: true, pid: 42 });
      await startRequest;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.state).toEqual({
      connected: false,
      serverUrl: null,
      name: null,
      pid: null,
    });
  });

  it('exposes the connector name with its process id', async () => {
    serviceMocks.requestExtensionService.mockResolvedValueOnce({
      connectors: [{ serverUrl: 'wss://example.com', name: 'work-mac', pid: 42 }],
    });

    const { result } = renderHook(() => useCloudConnectorStatus(true));

    await waitFor(() =>
      expect(result.current.state).toEqual({
        connected: true,
        serverUrl: 'wss://example.com',
        name: 'work-mac',
        pid: 42,
      }),
    );
  });
});
