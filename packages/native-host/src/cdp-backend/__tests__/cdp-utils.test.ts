import { describe, it, expect, vi } from 'vitest';
import {
  buildMultipartFormBody,
  dispatchCdpClick,
  dispatchCdpDrag,
  waitForPageLoad,
} from '../cdp-utils';
import { getCdpPageDialogs } from '../page-dialogs';

describe('dispatchCdpDrag', () => {
  it.each(['mouse', 'touch'] as const)(
    'skips overdue %s samples and still reaches the endpoint',
    async pointer => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      try {
        let pressed = false;
        const moves: any[] = [];
        const sendCommand = vi.fn(async (method: string, params: any) => {
          if (method === 'Runtime.evaluate')
            return { result: { value: { width: 800, height: 600 } } };
          if (params.type === 'mousePressed' || params.type === 'touchStart') pressed = true;
          if (pressed && (params.type === 'mouseMoved' || params.type === 'touchMove')) {
            moves.push(params);
            await new Promise(resolve => setTimeout(resolve, 5100));
          }
          return {};
        });
        const startedAt = performance.now();
        const result = dispatchCdpDrag(
          { client: { sendCommand } } as any,
          { x: 400, y: 269 },
          { x: 402, y: 269 },
          pointer,
          5000,
        );
        await vi.runAllTimersAsync();
        await expect(result).resolves.toEqual({ steps: 2 });
        expect(performance.now() - startedAt).toBeLessThan(11000);
        expect(pointer === 'mouse' ? moves.at(-1) : moves.at(-1).touchPoints[0]).toMatchObject({
          x: 402,
          y: 269,
        });
        expect(sendCommand.mock.calls.at(-1)?.[1].type).toBe(
          pointer === 'mouse' ? 'mouseReleased' : 'touchEnd',
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['mouse', 'touch'] as const)(
    'releases %s input when the press acknowledgement times out',
    async pointer => {
      const press = pointer === 'mouse' ? 'mousePressed' : 'touchStart';
      const sendCommand = vi.fn(async (method: string, params: any) => {
        if (method === 'Runtime.evaluate')
          return { result: { value: { width: 800, height: 600 } } };
        if (params.type === press) throw new Error(`CDP command timeout: ${method}`);
        return {};
      });
      await expect(
        dispatchCdpDrag(
          { client: { sendCommand } } as any,
          { x: 400, y: 269 },
          { x: 402, y: 269 },
          pointer,
          5000,
        ),
      ).rejects.toMatchObject({
        pageActionFailureStage: 'dispatch-uncertain',
      });
      expect(sendCommand.mock.calls.at(-1)?.[1].type).toBe(
        pointer === 'mouse' ? 'mouseReleased' : 'touchEnd',
      );
    },
  );
});

describe('buildMultipartFormBody', () => {
  it('builds a multipart body with a boundary matching the content type', () => {
    const { contentType, body } = buildMultipartFormBody({ nick: 'bob', token: 'xyz' });

    expect(contentType).toMatch(/^multipart\/form-data; boundary=----mearl-/);
    const boundary = contentType.split('boundary=')[1];

    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
    expect(body).toContain('Content-Disposition: form-data; name="nick"\r\n\r\nbob\r\n');
    expect(body).toContain('Content-Disposition: form-data; name="token"\r\n\r\nxyz\r\n');
  });

  it('produces a fresh boundary per call', () => {
    const a = buildMultipartFormBody({ x: '1' });
    const b = buildMultipartFormBody({ x: '1' });
    expect(a.contentType).not.toBe(b.contentType);
  });

  it('handles an empty field set (terminator only)', () => {
    const { contentType, body } = buildMultipartFormBody({});
    const boundary = contentType.split('boundary=')[1];
    expect(body).toBe(`--${boundary}--\r\n`);
  });
});

describe('dispatchCdpClick', () => {
  it('dispatches touch events in touch mode', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('width:')) {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    });

    await dispatchCdpClick({ client: { sendCommand } } as any, 90, 549, 'touch');

    const inputCalls = sendCommand.mock.calls.filter(([method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([method, params]) => [method, params.type])).toEqual([
      ['Input.dispatchTouchEvent', 'touchStart'],
      ['Input.dispatchTouchEvent', 'touchEnd'],
    ]);
    expect(inputCalls.map(([, , timeout]) => timeout)).toEqual([10_000, 10_000]);
  });

  it('dispatches a complete mouse sequence with bounded commands', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('width:')) {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: false } };
      return {};
    });

    await dispatchCdpClick({ client: { sendCommand } } as any, 90, 549, 'mouse');

    const inputCalls = sendCommand.mock.calls.filter(([method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([method, params, timeout]) => [method, params.type, timeout])).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved', 10_000],
      ['Input.dispatchMouseEvent', 'mousePressed', 10_000],
      ['Input.dispatchMouseEvent', 'mouseReleased', 10_000],
    ]);
    expect(inputCalls.map(([, params]) => params.buttons)).toEqual([undefined, 1, 0]);
  });

  it('keeps CSS pixel coordinates when viewport metrics use a different scale', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 426, clientHeight: 923 } };
      }
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('width:')) {
        return { result: { value: { width: 375, height: 812 } } };
      }
      return {};
    });

    await dispatchCdpClick({ client: { sendCommand } } as any, 187.5, 734.4, 'mouse');

    expect(sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 187.5, y: 734.4 }),
      10_000,
    );
    expect(sendCommand).not.toHaveBeenCalledWith('Page.getLayoutMetrics', {});
  });

  it('reports a bounded touch timeout without implying that retrying is safe', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('width:')) {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      if (method === 'Input.dispatchTouchEvent') {
        throw new Error(`CDP command timeout: ${method}`);
      }
      return {};
    });

    await expect(
      dispatchCdpClick({ client: { sendCommand } } as any, 90, 549, 'touch'),
    ).rejects.toMatchObject({
      message:
        'CDP Input.dispatchTouchEvent (touchStart) timed out after 10000ms. ' +
        'Touch input can stall on a hidden, background, or headless target; use clickMode "auto" or make the target visible. ' +
        'The page may already have changed; verify its current state before retrying.',
      pageActionFailureStage: 'dispatch-uncertain',
      pageActionAttempt: {
        inputCommand: { method: 'Input.dispatchTouchEvent', type: 'touchStart' },
        inputSequence: { press: 'uncertain', release: 'uncertain' },
      },
    });
    const inputCalls = sendCommand.mock.calls.filter(([method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([method, params, timeout]) => [method, params.type, timeout])).toEqual([
      ['Input.dispatchTouchEvent', 'touchStart', 10_000],
      ['Input.dispatchTouchEvent', 'touchEnd', 10_000],
    ]);
  });

  it('releases the mouse even when the press command fails', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('width:')) {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: false } };
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        throw new Error('press failed');
      }
      return {};
    });

    await expect(
      dispatchCdpClick({ client: { sendCommand } } as any, 90, 549, 'mouse'),
    ).rejects.toThrow('press failed');

    const inputCalls = sendCommand.mock.calls.filter(([method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([, params]) => params.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ]);
  });
});

describe('waitForPageLoad', () => {
  it('stops polling when a dialog opens between readiness checks', async () => {
    vi.useFakeTimers();
    try {
      const unsubscribe = vi.fn();
      const sendCommand = vi.fn(async () => ({ result: { value: 'loading' } }));
      const session = { client: { on: () => unsubscribe, sendCommand } } as any;
      const wait = waitForPageLoad(session, 3000, { waitUntil: 'domcontentloaded' });
      const rejected = expect(wait).rejects.toThrow('DIALOG_PENDING');
      await vi.advanceTimersByTimeAsync(100);
      getCdpPageDialogs(session).opened({ type: 'alert', message: 'Waiting' });
      await vi.advanceTimersByTimeAsync(200);
      await rejected;
      expect(sendCommand).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the load event without evaluating the renderer during a paused navigation', async () => {
    let loaded!: () => void;
    const dispose = vi.fn();
    const sendCommand = vi.fn();
    const session = {
      client: {
        sendCommand,
        on: vi.fn((_event, listener) => {
          loaded = listener;
          return dispose;
        }),
      },
    } as any;
    const pending = waitForPageLoad(session, 1000, { probeReadyState: false });
    expect(sendCommand).not.toHaveBeenCalled();
    loaded();
    await pending;
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('subscribes before checking document readiness', async () => {
    const calls: string[] = [];
    const session = {
      client: {
        on: vi.fn(() => {
          calls.push('subscribe');
          return () => calls.push('unsubscribe');
        }),
        sendCommand: vi.fn(async () => {
          calls.push('ready-state');
          return { result: { value: 'complete' } };
        }),
      },
    } as any;

    await waitForPageLoad(session, 1000);

    expect(calls).toEqual(['subscribe', 'ready-state', 'unsubscribe']);
  });
});
