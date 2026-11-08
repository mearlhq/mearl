import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNavigationSettlementTracker } from '../navigationTracker.js';

describe('navigation settlement tracker', () => {
  afterEach(() => vi.useRealTimers());

  it('settles a navigation on document load when network tracking is disabled', async () => {
    const tracker = createNavigationSettlementTracker({
      urlBefore: 'https://example.test/start',
    });
    tracker.markStarted('https://example.test/results', 'Results');
    tracker.markDocumentComplete();

    await expect(tracker.waitForResult(100)).resolves.toEqual(
      expect.objectContaining({
        urlAfter: 'https://example.test/results',
        title: 'Results',
        ready: true,
        settledBy: 'load',
        snapshotReasons: ['navigation'],
      }),
    );
    tracker.dispose();
  });

  it('waits for relevant requests and the network quiet window', async () => {
    vi.useFakeTimers();
    const tracker = createNavigationSettlementTracker({
      urlBefore: 'https://example.test/start',
      trackNetwork: true,
      networkIdleMs: 300,
    });
    tracker.requestStarted('search');
    tracker.markStarted('https://example.test/results');
    tracker.markDocumentComplete();
    const result = tracker.waitForResult(5000);

    await vi.advanceTimersByTimeAsync(1000);
    tracker.requestFinished('search');
    await vi.advanceTimersByTimeAsync(299);
    let settled = false;
    result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        settledBy: 'network-idle',
        pendingRequests: 0,
      }),
    );
    tracker.dispose();
  });

  it('keeps waiting after network idle while a skeleton is visible', async () => {
    vi.useFakeTimers();
    const sampleContent = vi
      .fn()
      .mockResolvedValueOnce({
        ready: false,
        meaningful: true,
        skeletonVisible: true,
        quietFor: 300,
        textLength: 200,
        interactiveCount: 3,
      })
      .mockResolvedValueOnce({
        ready: true,
        meaningful: true,
        skeletonVisible: false,
        quietFor: 700,
        textLength: 600,
        interactiveCount: 4,
      });
    const tracker = createNavigationSettlementTracker({
      urlBefore: 'https://example.test/start',
      trackNetwork: true,
      networkIdleMs: 300,
      sampleContent,
    });
    tracker.requestStarted('search');
    tracker.markStarted('https://example.test/results');
    tracker.markDocumentComplete();
    tracker.requestFinished('search');
    const result = tracker.waitForResult(5000);

    await vi.advanceTimersByTimeAsync(301);
    expect(sampleContent).toHaveBeenCalledOnce();
    let settled = false;
    result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        settledBy: 'network-idle',
        content: expect.objectContaining({ skeletonVisible: false }),
      }),
    );
    tracker.dispose();
  });

  it('extends navigation detection while an action request is active', async () => {
    vi.useFakeTimers();
    const tracker = createNavigationSettlementTracker({
      urlBefore: 'https://example.test/start',
      trackNetwork: true,
    });
    tracker.requestStarted('action');
    const started = tracker.waitForStart(100);

    await vi.advanceTimersByTimeAsync(1500);
    tracker.markStarted('https://example.test/results');
    await expect(started).resolves.toBe(true);
    tracker.dispose();
  });

  it('accepts stable content when a background request remains open', async () => {
    vi.useFakeTimers();
    const sampleContent = vi.fn().mockResolvedValue({
      ready: true,
      meaningful: true,
      skeletonVisible: false,
      quietFor: 800,
      textLength: 600,
      interactiveCount: 4,
    });
    const tracker = createNavigationSettlementTracker({
      urlBefore: 'https://example.test/start',
      trackNetwork: true,
      networkIdleMs: 500,
      contentReadyAfterMs: 1000,
      sampleContent,
    });
    tracker.requestStarted('background-stream');
    tracker.markStarted('https://example.test/ota');
    tracker.markDocumentComplete();
    const result = tracker.waitForResult(5000);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        settledBy: 'content-stable',
        pendingRequests: 1,
      }),
    );
    expect(sampleContent).toHaveBeenCalledOnce();
    tracker.dispose();
  });

  it('falls back to document load when network observation becomes unavailable', async () => {
    const tracker = createNavigationSettlementTracker({
      urlBefore: 'https://example.test/start',
      trackNetwork: true,
    });
    tracker.requestStarted('search');
    tracker.markStarted('https://example.test/results');
    tracker.setNetworkAvailable(false);
    tracker.markDocumentComplete();

    await expect(tracker.waitForResult(100)).resolves.toEqual(
      expect.objectContaining({ ready: true, settledBy: 'load', pendingRequests: 0 }),
    );
    tracker.dispose();
  });

  it('settles same-document action requests independently of navigation', async () => {
    vi.useFakeTimers();
    const tracker = createNavigationSettlementTracker({
      urlBefore: 'https://example.test/form',
      trackNetwork: true,
      networkIdleMs: 300,
    });
    tracker.requestStarted('refresh');
    const result = tracker.waitForNetworkIdle(5000);
    tracker.requestFinished('refresh');
    await vi.advanceTimersByTimeAsync(300);

    await expect(result).resolves.toEqual(
      expect.objectContaining({ ready: true, settledBy: 'network-idle' }),
    );
    expect(tracker.hasStarted()).toBe(false);
    tracker.dispose();
  });
});
