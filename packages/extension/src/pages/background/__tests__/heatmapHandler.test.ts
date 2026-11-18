import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getHeatmapPage,
  handleStartHeatmap,
  handleStopHeatmap,
  reconcileHeatmapService,
  stopDevicePreviewHeatmap,
} from '../heatmapHandler';
import { fetchHeatmapData } from '../api/heatmap';
import { sendTabMessageToFramesSafe } from '../frameMessaging';
import { isExternalServiceEnabled } from '../externalServices';
import { resolveToolboxPageFrame } from '../toolboxPageFrame';

vi.mock('../browserCapabilityRegistry', () => ({
  browserCapabilityRegistry: () => ({
    settings: async () => ({
      extension: {
        heatmap: {
          bodySpmPrefix: '181',
          measures: [
            { id: 'module_pos_clk_rate_1d', format: 'percent' },
            { id: 'views', format: 'number' },
          ],
        },
      },
    }),
  }),
}));

vi.mock('../toolboxPageFrame', () => ({ resolveToolboxPageFrame: vi.fn() }));
vi.mock('../externalServices', () => ({ isExternalServiceEnabled: vi.fn() }));
vi.mock('../frameMessaging', () => ({ sendTabMessageToFramesSafe: vi.fn() }));
vi.mock('../api/heatmap', () => ({
  fetchHeatmapData: vi.fn(),
}));

const rateMeasures = ['module_pos_clk_rate_1d'];

beforeEach(async () => {
  await handleStopHeatmap(12);
  vi.clearAllMocks();
  vi.mocked(isExternalServiceEnabled).mockResolvedValue(true);
  vi.mocked(sendTabMessageToFramesSafe).mockResolvedValue([
    { frameId: 0, response: { success: true } },
  ]);
  vi.mocked(fetchHeatmapData).mockResolvedValue({ success: true, points: [], cached: false });
});

describe('heatmap page detection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { frameId: 0, meta: '181', body: 'example-page', a: '181', ab: '181.example-page' },
    { frameId: 14, body: '181.example-page', a: '181', ab: '181.example-page' },
    { frameId: 14, tagged: '181.example-page.c.d', a: '181', ab: '181.example-page' },
    { frameId: 0, meta: '181.example-page', a: '181', ab: '181.example-page' },
    { frameId: 0, meta: '181', a: '181', ab: null },
    { frameId: 0, meta: '181', tagged: '182.unrelated.c.d', a: '181', ab: null },
    { frameId: 0, meta: '1181', body: 'example-page', a: '1181', ab: '1181.example-page' },
    { frameId: 0, meta: '182', body: '181.unrelated', a: '182', ab: null },
    { frameId: 0, body: '181', a: null, ab: null },
  ])(
    'reads page SPM from frame $frameId with A $a and AB $ab',
    async ({ frameId, meta, body, tagged, a, ab }) => {
      vi.mocked(resolveToolboxPageFrame).mockResolvedValueOnce(frameId);
      const executeScript = vi.fn(async ({ func }: { func: () => unknown }) => {
        const metaElement = document.createElement('meta');
        metaElement.name = 'data-spm';
        metaElement.content = meta ?? '';
        document.head.append(metaElement);
        if (body) document.body.setAttribute('data-spm', body);
        if (tagged) document.body.setAttribute('data-spm-abcd', tagged);
        try {
          return [{ result: func() }];
        } finally {
          metaElement.remove();
          document.body.removeAttribute('data-spm');
          document.body.removeAttribute('data-spm-abcd');
        }
      });
      vi.stubGlobal('chrome', { ...chrome, scripting: { executeScript } });

      expect(await getHeatmapPage(12)).toEqual({ spmA: a, spmAB: ab });
      expect(executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ target: { tabId: 12, frameIds: [frameId] } }),
      );
    },
  );

  it('reports no page SPM when the extension cannot read its DOM', async () => {
    vi.mocked(resolveToolboxPageFrame).mockResolvedValueOnce(0);
    vi.stubGlobal('chrome', {
      ...chrome,
      scripting: { executeScript: vi.fn().mockRejectedValue(new Error('Permission denied')) },
    });

    expect(await getHeatmapPage(12)).toBeNull();
  });
});

describe('heatmap service lifecycle', () => {
  it('cancels a pending preview heatmap during takeover without stopping the DevTools heatmap', async () => {
    let finishPreview!: (result: Awaited<ReturnType<typeof fetchHeatmapData>>) => void;
    vi.mocked(fetchHeatmapData).mockReturnValueOnce(
      new Promise(resolve => {
        finishPreview = resolve;
      }),
    );
    const preview = handleStartHeatmap(12, 'a.b', '20261012', rateMeasures, true);
    await vi.waitFor(() => expect(fetchHeatmapData).toHaveBeenCalledOnce());
    stopDevicePreviewHeatmap(12);
    const devtools = await handleStartHeatmap(12, 'a.b', '20261012', rateMeasures);
    finishPreview({ success: true, points: [], cached: false });

    expect(await preview).toMatchObject({ success: false, error: 'HEATMAP_CANCELLED' });
    expect(devtools.success).toBe(true);
    stopDevicePreviewHeatmap(12);
    expect(sendTabMessageToFramesSafe).toHaveBeenCalledOnce();
    expect(sendTabMessageToFramesSafe).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ action: 'renderHeatmap' }),
    );
  });

  it('delivers the selected measures in order with one data request', async () => {
    const points = [{ spm: 'a.b.c.d', spmName: null, measures: { views: 12 } }];
    vi.mocked(fetchHeatmapData).mockResolvedValueOnce({ success: true, points, cached: false });
    const result = await handleStartHeatmap(12, 'a.b', '20261012', ['views', ...rateMeasures]);

    expect(result).toEqual({ success: true, cached: false });
    expect(fetchHeatmapData).toHaveBeenCalledExactlyOnceWith('a.b', '20261012');
    expect(sendTabMessageToFramesSafe).toHaveBeenCalledExactlyOnceWith(12, {
      action: 'renderHeatmap',
      payload: {
        measures: [
          { id: 'views', format: 'number' },
          { id: rateMeasures[0], format: 'percent' },
        ],
        points,
      },
    });
  });

  it('does not render if Tracking metadata was disabled while data was loading', async () => {
    vi.mocked(isExternalServiceEnabled).mockResolvedValue(false);
    expect(await handleStartHeatmap(12, 'a.b', '20261012', rateMeasures)).toEqual({
      success: false,
      errorCode: 'unknown',
      error: 'TRACKING_METADATA_DISABLED',
    });
    expect(sendTabMessageToFramesSafe).not.toHaveBeenCalled();
  });

  it('clears an existing heatmap when the service is disabled', async () => {
    await handleStartHeatmap(12, 'a.b', '20261012', rateMeasures);
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
    const starting = handleStartHeatmap(12, 'a.b', '20261012', rateMeasures);
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
    const starting = handleStartHeatmap(12, 'a.b', '20261012', rateMeasures);
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
    const first = handleStartHeatmap(12, 'a.b', '20261012', rateMeasures);
    await vi.waitFor(() => expect(finishRender).toBeDefined());
    const stopping = handleStopHeatmap(12);
    const latest = handleStartHeatmap(12, 'a.b', '20261013', rateMeasures);
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
    const first = handleStartHeatmap(12, 'a.b', '20261012', rateMeasures);
    await vi.waitFor(() => expect(finishRender).toBeDefined());
    vi.mocked(fetchHeatmapData).mockResolvedValueOnce({
      success: false,
      errorCode: 'network',
      error: 'offline',
    });
    const failed = handleStartHeatmap(12, 'a.b', '20261013', rateMeasures);
    await Promise.resolve();
    const latest = handleStartHeatmap(12, 'a.b', '20261014', rateMeasures);
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
    const starting = handleStartHeatmap(12, 'a.b', '20261012', rateMeasures);
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
