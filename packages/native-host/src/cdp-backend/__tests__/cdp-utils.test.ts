import { describe, it, expect, vi } from 'vitest';
import { buildMultipartFormBody, dispatchCdpClick, waitForPageLoad } from '../cdp-utils';

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
