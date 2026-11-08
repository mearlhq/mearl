import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanelActions } from '../usePanelActions';

const safeChromeMocks = vi.hoisted(() => ({
  sendMessageSafely: vi.fn(),
}));

vi.mock('../../utils/safeChrome', () => safeChromeMocks);

describe('usePanelActions', () => {
  beforeEach(() => {
    safeChromeMocks.sendMessageSafely.mockReset().mockResolvedValue({
      success: true,
      id: 'override-1',
    });
  });

  it('resolves imported refs at the common mock boundary', async () => {
    const syncDebuggerStatus = vi.fn().mockResolvedValue(undefined);
    const options: Parameters<typeof usePanelActions>[0] = {
      tabId: 1,
      requests: [],
      nonCapturedRequests: [],
      selectedRequestId: null,
      setPinnedFields: vi.fn(),
      setPinnedEventFields: vi.fn(),
      setApiOverrides: vi.fn(),
      setRequests: vi.fn(),
      setNonCapturedRequests: vi.fn(),
      syncDebuggerStatus,
      rumEvents: [],
      selectedRumEventId: null,
    };
    const { result } = renderHook(() => usePanelActions(options));

    await act(async () => {
      await result.current.addMockOverride({
        apiName: 'mtop.example.record.detail.query',
        responseData: {
          api: 'mtop.example.record.detail.query',
          data: {
            models: {
              flight: {
                oldSegments: [{ flightNo: 'UA2210' }],
                previousSegment: { $ref: '$.model.models.flight.oldSegments[0]' },
              },
            },
          },
        },
      });
    });

    expect(safeChromeMocks.sendMessageSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'setResponseOverride',
        data: expect.objectContaining({
          responseData: expect.objectContaining({
            data: {
              models: {
                flight: {
                  oldSegments: [{ flightNo: 'UA2210' }],
                  previousSegment: { flightNo: 'UA2210' },
                },
              },
            },
          }),
          modifiedData: expect.objectContaining({
            data: {
              models: {
                flight: {
                  oldSegments: [{ flightNo: 'UA2210' }],
                  previousSegment: { flightNo: 'UA2210' },
                },
              },
            },
          }),
        }),
      }),
    );
    expect(syncDebuggerStatus).toHaveBeenCalledOnce();
  });
});
