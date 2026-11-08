import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStartHeatmap, handleStopHeatmap, reconcileHeatmapService } from '../heatmapHandler';
import { fetchHeatmapData } from '../api/heatmap';
import { sendTabMessageToFramesSafe } from '../frameMessaging';
import { isExternalServiceEnabled } from '../externalServices';

vi.mock('../browserCapabilityRegistry', () => ({ browserCapabilityRegistry: () => ({ settings: async () => ({ extension: { heatmap: { measures: [{ id: 'module_pos_clk_rate_1d', format: 'percent' }] } } }) }) }));

vi.mock('../externalServices', () => ({ isExternalServiceEnabled: vi.fn() }));
vi.mock('../frameMessaging', () => ({ sendTabMessageToFramesSafe: vi.fn() }));
vi.mock('../api/heatmap', () => ({
  fetchHeatmapData: vi.fn(),
}));

beforeEach(async () => {
  await handleStopHeatmap(12);
  vi.clearAllMocks();
  vi.mocked(isExternalServiceEnabled).mockResolvedValue(true);
  vi.mocked(sendTabMessageToFramesSafe).mockResolvedValue([
    { frameId: 0, response: { success: true } },
  ]);
  vi.mocked(fetchHeatmapData).mockResolvedValue({ success: true, points: [], cached: false });
});

describe('heatmap service lifecycle', () => {
  it('does not render if Tracking metadata was disabled while data was loading', async () => {
    vi.mocked(isExternalServiceEnabled).mockResolvedValue(false);
    expect(await handleStartHeatmap(12, 'a.b', '20261012', 'module_pos_clk_rate_1d')).toEqual({
      success: false,
      errorCode: 'unknown',
      error: 'TRACKING_METADATA_DISABLED',
    });
    expect(sendTabMessageToFramesSafe).not.toHaveBeenCalled();
  });

  it('clears an existing heatmap when the service is disabled', async () => {
    await handleStartHeatmap(12, 'a.b', '20261012', 'module_pos_clk_rate_1d');
    vi.mocked(isExternalServiceEnabled).mockResolvedValue(false);
    await reconcileHeatmapService();
    expect(sendTabMessageToFramesSafe).toHaveBeenLastCalledWith(12, { action: 'stopHeatmap' });
    vi.mocked(sendTabMessageToFramesSafe).mockClear();
    await reconcileHeatmapService();
    expect(sendTabMessageToFramesSafe).not.toHaveBeenCalled();
  });

  it('sends stop after a render that was already waiting for frame delivery', async () => {
    let finishRender!: () => void;
    vi.mocked(sendTabMessageToFramesSafe).mockImplementation(async (_tabId, message: any) => {
      if (message.action === 'renderHeatmap')
        await new Promise<void>(resolve => {
          finishRender = resolve;
        });
      return [{ frameId: 0, response: { success: true } }];
    });
    const starting = handleStartHeatmap(12, 'a.b', '20261012', 'module_pos_clk_rate_1d');
    await vi.waitFor(() => expect(finishRender).toBeDefined());
    vi.mocked(isExternalServiceEnabled).mockResolvedValue(false);
    const stopping = reconcileHeatmapService();
    finishRender();
    expect((await starting).success).toBe(false);
    await stopping;
    expect(sendTabMessageToFramesSafe).toHaveBeenLastCalledWith(12, { action: 'stopHeatmap' });
  });

  it('cancels pending data loads without waiting for the server', async () => {
    let finishData!: (value: Awaited<ReturnType<typeof fetchHeatmapData>>) => void;
    vi.mocked(fetchHeatmapData).mockReturnValue(
      new Promise(resolve => {
        finishData = resolve;
      }),
    );
    const starting = handleStartHeatmap(12, 'a.b', '20261012', 'module_pos_clk_rate_1d');
    await handleStopHeatmap(12);
    finishData({ success: true, points: [], cached: false });
    expect((await starting).success).toBe(false);
    expect(sendTabMessageToFramesSafe).not.toHaveBeenCalled();
  });

  it('does not let an earlier stop erase a newly requested heatmap', async () => {
    let finishRender!: () => void;
    vi.mocked(sendTabMessageToFramesSafe).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        finishRender = resolve;
      });
      return [{ frameId: 0, response: { success: true } }];
    });
    const first = handleStartHeatmap(12, 'a.b', '20261012', 'module_pos_clk_rate_1d');
    await vi.waitFor(() => expect(finishRender).toBeDefined());
    const stopping = handleStopHeatmap(12);
    const latest = handleStartHeatmap(12, 'a.b', '20261013', 'module_pos_clk_rate_1d');
    finishRender();
    await Promise.all([first, stopping]);
    expect((await latest).success).toBe(true);
    expect(sendTabMessageToFramesSafe).toHaveBeenLastCalledWith(
      12,
      expect.objectContaining({ action: 'renderHeatmap' }),
    );
  });

  it('keeps a pending render in the same queue when a newer data request fails', async () => {
    let finishRender!: () => void;
    vi.mocked(sendTabMessageToFramesSafe).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        finishRender = resolve;
      });
      return [{ frameId: 0, response: { success: true } }];
    });
    const first = handleStartHeatmap(12, 'a.b', '20261012', 'module_pos_clk_rate_1d');
    await vi.waitFor(() => expect(finishRender).toBeDefined());
    vi.mocked(fetchHeatmapData).mockResolvedValueOnce({
      success: false,
      errorCode: 'network',
      error: 'offline',
    });
    const failed = handleStartHeatmap(12, 'a.b', '20261013', 'module_pos_clk_rate_1d');
    await Promise.resolve();
    const latest = handleStartHeatmap(12, 'a.b', '20261014', 'module_pos_clk_rate_1d');
    finishRender();
    await Promise.all([first, failed]);
    expect((await latest).success).toBe(true);
    expect(sendTabMessageToFramesSafe).toHaveBeenLastCalledWith(
      12,
      expect.objectContaining({ action: 'renderHeatmap' }),
    );
  });

  it('queues an orphaned overlay cleanup before a newly requested render', async () => {
    let finishStop!: () => void;
    vi.mocked(sendTabMessageToFramesSafe).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        finishStop = resolve;
      });
      return [{ frameId: 0, response: { success: true } }];
    });
    const stopping = handleStopHeatmap(12);
    await vi.waitFor(() => expect(finishStop).toBeDefined());
    const starting = handleStartHeatmap(12, 'a.b', '20261012', 'module_pos_clk_rate_1d');
    await Promise.resolve();
    expect(sendTabMessageToFramesSafe).toHaveBeenCalledOnce();
    finishStop();
    await stopping;
    expect((await starting).success).toBe(true);
    expect(sendTabMessageToFramesSafe).toHaveBeenLastCalledWith(
      12,
      expect.objectContaining({ action: 'renderHeatmap' }),
    );
  });
});
