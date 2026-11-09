import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  releaseDebuggerLease,
  getEmulationConfigForTab,
  getContainerTopFrame,
  getFrameTarget,
  getFrameViewportTransform,
  resolveDebuggerFrameExecutionContextId,
} = vi.hoisted(() => ({
  releaseDebuggerLease: vi.fn(),
  getEmulationConfigForTab: vi.fn(),
  getContainerTopFrame: vi.fn(),
  getFrameTarget: vi.fn(),
  getFrameViewportTransform: vi.fn(),
  resolveDebuggerFrameExecutionContextId: vi.fn(),
}));

vi.mock('../../debuggerSessionManager', () => ({
  acquireDebuggerLease: vi.fn().mockResolvedValue({ release: releaseDebuggerLease }),
  resolveDebuggerFrameExecutionContextId,
}));
vi.mock('../../deviceEmulationState', () => ({ getEmulationConfigForTab }));
vi.mock('../../utils/containerFrameTarget', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/containerFrameTarget')>()),
  getContainerTopFrame,
  getFrameTarget,
  getFrameViewportTransform,
}));
vi.mock('../pageRefs', () => ({ resolveRef: vi.fn(), deleteRef: vi.fn() }));
vi.mock('../../../../shared/proxyPermissions', () => ({
  isAgentDomainAuthorized: vi.fn().mockResolvedValue(true),
}));

import { acquireDebuggerLease } from '../../debuggerSessionManager';
import {
  handlePageClick,
  handlePageDrag,
  handlePageEval,
  handlePageInspect,
  handlePagePress,
  handlePageScroll,
  handlePageType,
  handlePageUpload,
  handlePageWait,
} from '../interactionHandlers';
import { resolveRef } from '../pageRefs';

beforeEach(() => {
  getContainerTopFrame.mockResolvedValue(undefined);
  getFrameTarget.mockResolvedValue(undefined);
  getFrameViewportTransform.mockReset();
  resolveDebuggerFrameExecutionContextId.mockReset().mockResolvedValue(17);
});

describe('page upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets file paths directly on the input', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 2 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 3 } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'file-input' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: 'input' } };
      return {};
    }) as any;

    await expect(
      handlePageUpload(
        { tabId: 1, selector: '#upload', filePaths: ['/tmp/photo.jpg'] },
        () => null,
      ),
    ).resolves.toEqual({ uploaded: true, fileCount: 1, tag: 'input' });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'DOM.setFileInputFiles',
      {
        files: ['/tmp/photo.jpg'],
        backendNodeId: 3,
      },
    );
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.some(([, method]) => method.startsWith('Page.setInterceptFileChooserDialog')),
    ).toBe(false);
  });

  it('preserves the direct upload error without opening a file chooser', async () => {
    const uploadError = new Error('Could not read file');
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 2 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 3 } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'file-input' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: 'input' } };
      if (method === 'DOM.setFileInputFiles') throw uploadError;
      return {};
    }) as any;

    await expect(
      handlePageUpload(
        { tabId: 1, selector: '#upload', filePaths: ['/tmp/missing.jpg'] },
        () => null,
      ),
    ).rejects.toBe(uploadError);
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.map(([, method]) => method)
        .filter(method => method.includes('FileChooser')),
    ).toEqual([]);
    expect(releaseDebuggerLease).toHaveBeenCalledOnce();
  });
});

describe('actions in the active preview WebView', () => {
  const frame = {
    frameId: 'business',
    sessionId: 'child',
    phoneFrame: true,
    url: 'https://example.test/',
  };

  it('routes custom waits and CSS uploads to the business frame', async () => {
    getContainerTopFrame.mockResolvedValue(frame);
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params: any) => {
      if (method === 'Runtime.evaluate') {
        return { result: params.returnByValue ? { value: true } : { objectId: 'upload-input' } };
      }
      if (method === 'Runtime.callFunctionOn') return { result: { value: 'input' } };
      return {};
    }) as any;
    const target = { tabId: 1, sessionId: 'child' };

    await expect(
      handlePageWait({ tabId: 1, condition: 'document.readyState === "complete"' }, () => null),
    ).resolves.toMatchObject({ waited: true, mode: 'condition' });
    await expect(
      handlePageUpload(
        { tabId: 1, selector: '#upload', filePaths: ['/tmp/photo.jpg'] },
        () => null,
      ),
    ).resolves.toMatchObject({ uploaded: true });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      target,
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 17, returnByValue: true }),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(target, 'DOM.setFileInputFiles', {
      files: ['/tmp/photo.jpg'],
      objectId: 'upload-input',
    });
  });

  it('rejects a reference from the covered WebView before touching its DOM', async () => {
    getContainerTopFrame.mockResolvedValue(frame);
    vi.mocked(resolveRef).mockReturnValueOnce({
      frameId: 'covered',
      backendNodeId: 3,
      role: 'textbox',
      name: 'Covered',
    });
    chrome.debugger.sendCommand = vi.fn() as any;

    await expect(
      handlePageType({ tabId: 1, selector: '@e1', text: 'hello' }, () => null),
    ).rejects.toThrow('outside the active preview page');
    expect(getFrameTarget).toHaveBeenCalledWith(1, 'covered', 'business');
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
  });
});

describe('page inspection', () => {
  it('returns structured CSS locator and layout results without taking a snapshot', async () => {
    const value = {
      selector: '.card',
      filter: 'all',
      candidateCount: 2,
      count: 2,
      matches: [],
      truncated: true,
    };
    chrome.debugger.sendCommand = vi.fn(async (_target, method) =>
      method === 'Runtime.evaluate' ? { result: { value } } : {},
    ) as any;

    await expect(handlePageInspect({ tabId: 1, selector: '.card' }, () => null)).resolves.toEqual(
      value,
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('querySelectorAll') }),
    );
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.some(([, method]) => method.startsWith('Accessibility.')),
    ).toBe(false);
  });
});

describe('page keyboard input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches paired trusted key events on a visible page', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (
        method === 'Runtime.evaluate' &&
        (params as any).expression === 'document.visibilityState'
      ) {
        return { result: { value: 'visible' } };
      }
      return {};
    }) as any;

    await expect(
      handlePagePress({ tabId: 1, key: 'Enter', modifiers: ['Control', 'Shift'] }, () => null),
    ).resolves.toEqual({
      pressed: true,
      key: 'Enter',
      dispatchMode: 'trusted-input',
    });

    const inputCalls = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(([, method]) => method === 'Input.dispatchKeyEvent');
    expect(
      inputCalls.map(([, , params]) => [(params as any).type, (params as any).modifiers]),
    ).toEqual([
      ['keyDown', 10],
      ['keyUp', 10],
    ]);
  });

  it('uses DOM keyboard events automatically on a hidden page', async () => {
    const domResult = {
      pressed: true,
      target: { tag: 'button' },
      keydownCanceled: false,
      defaultAction: 'click',
    };
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: (params as any).expression === 'document.visibilityState' ? 'hidden' : domResult,
          },
        };
      }
      return {};
    }) as any;

    await expect(handlePagePress({ tabId: 1, key: 'Enter' }, () => null)).resolves.toEqual({
      ...domResult,
      key: 'Enter',
      dispatchMode: 'dom',
      fallbackReason: 'page-hidden',
    });
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.some(([, method]) => method === 'Input.dispatchKeyEvent'),
    ).toBe(false);
  });

  it('keeps explicit keyboard input on a hidden page without a visibility probe', async () => {
    chrome.debugger.sendCommand = vi.fn(async () => ({})) as any;

    await expect(
      handlePagePress({ tabId: 1, key: 'Escape', pressMode: 'keyboard' }, () => null),
    ).resolves.toMatchObject({ dispatchMode: 'trusted-input' });
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.filter(([, method]) => method === 'Runtime.evaluate'),
    ).toHaveLength(0);
  });

  it('queues key release and classifies a stalled key acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
        if (method === 'Input.dispatchKeyEvent' && (params as any).type === 'keyDown') {
          return new Promise(() => {});
        }
        return {};
      }) as any;

      const result = handlePagePress(
        { tabId: 1, key: 'Escape', pressMode: 'keyboard' },
        () => null,
      );
      const rejection = expect(result).rejects.toMatchObject({
        pageActionFailureStage: 'dispatch-uncertain',
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;

      expect(
        vi
          .mocked(chrome.debugger.sendCommand)
          .mock.calls.filter(([, method]) => method === 'Input.dispatchKeyEvent')
          .map(([, , params]) => (params as any).type),
      ).toEqual(['keyDown', 'keyUp']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('page dragging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEmulationConfigForTab.mockReturnValue({ touch: false });
    chrome.scripting = {
      executeScript: vi.fn().mockResolvedValue([{ result: 'visible' }]),
    } as any;
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        if ((params as any).expression === 'document.visibilityState') {
          return { result: { value: 'visible' } };
        }
        return { result: { value: { width: 430, height: 932 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 430, clientHeight: 932 } };
      }
      return {};
    }) as any;
  });

  it('dispatches a segmented mouse drag while holding the left button', async () => {
    await expect(
      handlePageDrag(
        {
          tabId: 1,
          from: { x: 350, y: 80 },
          to: { x: 80, y: 80 },
          durationMs: 0,
        },
        () => null,
      ),
    ).resolves.toMatchObject({
      dragged: true,
      pointerType: 'mouse',
      steps: 2,
    });

    const inputCalls = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(([, method]) => method.startsWith('Input.'));
    expect(
      inputCalls.map(([, method, params]) => [
        method,
        (params as any).type,
        (params as any).buttons,
      ]),
    ).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved', undefined],
      ['Input.dispatchMouseEvent', 'mousePressed', 1],
      ['Input.dispatchMouseEvent', 'mouseMoved', 1],
      ['Input.dispatchMouseEvent', 'mouseMoved', 1],
      ['Input.dispatchMouseEvent', 'mouseReleased', 0],
    ]);
    expect(inputCalls.at(-1)?.[2]).toMatchObject({ x: 80, y: 80 });
    expect(releaseDebuggerLease).toHaveBeenCalledTimes(2);
  });

  it('uses touch events automatically in a mobile-emulated tab', async () => {
    getEmulationConfigForTab.mockReturnValue({ touch: true });

    await handlePageDrag(
      {
        tabId: 1,
        from: { x: 320, y: 100 },
        to: { x: 90, y: 100 },
        durationMs: 0,
      },
      () => null,
    );

    const inputCalls = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(([, method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([, method, params]) => [method, (params as any).type])).toEqual([
      ['Input.dispatchTouchEvent', 'touchStart'],
      ['Input.dispatchTouchEvent', 'touchMove'],
      ['Input.dispatchTouchEvent', 'touchMove'],
      ['Input.dispatchTouchEvent', 'touchEnd'],
    ]);
  });

  it('uses DOM simulation without activating a hidden tab', async () => {
    getEmulationConfigForTab.mockReturnValue({ touch: true });
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (
        method === 'Runtime.evaluate' &&
        (params as any).expression === 'document.visibilityState'
      ) {
        return { result: { value: 'hidden' } };
      }
      if (
        method === 'Runtime.evaluate' &&
        (params as any).expression.includes('elementFromPoint')
      ) {
        return { result: { value: { dragged: true, steps: 2 } } };
      }
      return {};
    }) as any;

    await expect(
      handlePageDrag(
        {
          tabId: 1,
          from: { x: 350, y: 80 },
          to: { x: 80, y: 80 },
          durationMs: 0,
        },
        () => null,
      ),
    ).resolves.toMatchObject({
      dragged: true,
      dispatchMode: 'dom',
      pointerType: 'touch',
      fallbackReason: 'page-hidden',
      steps: 2,
    });
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.some(([, method]) => method.startsWith('Input.')),
    ).toBe(false);
  });
});

describe('page scrolling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEmulationConfigForTab.mockReturnValue({ touch: false });
    chrome.scripting = {
      executeScript: vi.fn(),
    } as any;
  });

  it('scrolls a container selected by CSS', async () => {
    chrome.debugger.sendCommand = vi
      .fn()
      .mockResolvedValue({ result: { value: { scrollY: 800, scrollHeight: 2400 } } });

    await expect(
      handlePageScroll(
        { tabId: 1, selector: '.virtual-list', direction: 'down', distance: 800 },
        () => null,
      ),
    ).resolves.toEqual({ scrollY: 800, scrollHeight: 2400 });

    const evaluation = vi.mocked(chrome.debugger.sendCommand).mock.calls[0][2] as any;
    expect(evaluation.expression).toContain('const sel = ".virtual-list"');
    expect(evaluation.expression).toContain('return scroll.call(el, dir, dist, sel, policy)');
  });

  it('scrolls a container selected by snapshot ref', async () => {
    vi.mocked(resolveRef).mockReturnValue({
      backendNodeId: 42,
      role: 'list',
      name: 'Results',
    });
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'list' } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { scrollY: 600, scrollHeight: 3000 } } };
      }
      return {};
    }) as any;

    await expect(
      handlePageScroll({ tabId: 1, selector: '@e4', direction: 'down', distance: 600 }, () => null),
    ).resolves.toEqual({ scrollY: 600, scrollHeight: 3000 });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.callFunctionOn',
      expect.objectContaining({
        objectId: 'list',
        arguments: [{ value: 'down' }, { value: 600 }, { value: '@e4' }, { value: 'self' }],
      }),
    );
  });
});

describe('page point clicking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEmulationConfigForTab.mockReturnValue({ touch: false });
    chrome.scripting = {
      executeScript: vi.fn(),
    } as any;
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        if ((params as any).expression === 'document.visibilityState') {
          return { result: { value: 'visible' } };
        }
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      return {};
    }) as any;
  });

  it('classifies a stale snapshot ref before dispatching input', async () => {
    vi.mocked(resolveRef).mockReturnValue(undefined);

    await expect(
      handlePageClick({ tabId: 1, selector: '@e9801', clickMode: 'dom' }, () => null),
    ).rejects.toMatchObject({
      message: 'Ref @e9801 not found. Run page_snapshot first to get fresh refs.',
      pageActionFailureStage: 'precondition',
    });
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('dispatches one touch gesture on a visible mobile-emulated page', async () => {
    getEmulationConfigForTab.mockReturnValue({ touch: true });

    await handlePageClick({ tabId: 1, point: { x: 90, y: 549 } }, () => null);

    const evaluatedExpressions = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(([, method]) => method === 'Runtime.evaluate')
      .map(([, , params]) => (params as any).expression);
    expect(evaluatedExpressions).toContain('document.visibilityState');
    const inputCalls = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(([, method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([, method, params]) => [method, (params as any).type])).toEqual([
      ['Input.dispatchTouchEvent', 'touchStart'],
      ['Input.dispatchTouchEvent', 'touchEnd'],
    ]);
  });

  it('dispatches one mouse click on a non-touch device', async () => {
    await handlePageClick({ tabId: 1, point: { x: 90, y: 549 } }, () => null);

    const inputCalls = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(([, method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([, method, params]) => [method, (params as any).type])).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved'],
      ['Input.dispatchMouseEvent', 'mousePressed'],
      ['Input.dispatchMouseEvent', 'mouseReleased'],
    ]);
    expect(inputCalls.map(([, , params]) => (params as any).buttons)).toEqual([undefined, 1, 0]);
  });

  it('keeps CSS pixel coordinates when viewport metrics use a different scale', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (
        method === 'Runtime.evaluate' &&
        (params as any).expression === 'document.visibilityState'
      ) {
        return { result: { value: 'visible' } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 375, height: 812 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 426, clientHeight: 923 } };
      }
      return {};
    }) as any;

    await handlePageClick({ tabId: 1, point: { x: 187.5, y: 734.4 } }, () => null);

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 187.5, y: 734.4 }),
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 1 },
      'Page.getLayoutMetrics',
    );
  });

  it('releases the mouse even when the press command fails', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        if ((params as any).expression === 'document.visibilityState') {
          return { result: { value: 'visible' } };
        }
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      if (method === 'Input.dispatchMouseEvent' && (params as any).type === 'mousePressed') {
        throw new Error('press failed');
      }
      return {};
    }) as any;

    await expect(
      handlePageClick({ tabId: 1, point: { x: 90, y: 549 } }, () => null),
    ).rejects.toThrow('press failed');

    const inputCalls = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(([, method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([, , params]) => (params as any).type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ]);
  });

  it('uses the DOM fallback immediately when the page is hidden', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = (params as any).expression as string;
        if (expression === 'document.visibilityState') {
          return { result: { value: 'hidden' } };
        }
        return {
          result: {
            value: {
              clicked: true,
              tag: 'div',
              text: 'Open panel',
              cx: 60,
              cy: 196,
              strategy: 'self',
              distance: 0,
            },
          },
        };
      }
      return {};
    }) as any;

    await expect(
      handlePageClick({ tabId: 1, selector: '.panel-trigger' }, () => null),
    ).resolves.toMatchObject({
      clicked: true,
      dispatchMode: 'dom',
      fallbackReason: 'page-hidden',
    });
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.filter(([, method]) => method.startsWith('Input.')),
    ).toHaveLength(0);
  });

  it('rejects a disabled option reached by a DOM point click', async () => {
    chrome.debugger.sendCommand = vi.fn(async () => ({
      result: { value: { error: 'Cannot select a disabled option' } },
    })) as any;
    await expect(
      handlePageClick(
        {
          tabId: 1,
          point: { x: 20, y: 30 },
          clickMode: 'dom',
        },
        () => null,
      ),
    ).rejects.toMatchObject({ pageActionFailureStage: 'precondition' });
  });

  it('uses the DOM fallback for point clicks on a hidden page', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = (params as any).expression as string;
        if (expression === 'document.visibilityState') {
          return { result: { value: 'hidden' } };
        }
        return {
          result: {
            value: {
              tag: 'button',
              text: 'Continue',
              cx: 90,
              cy: 549,
              strategy: 'self',
              distance: 0,
            },
          },
        };
      }
      return {};
    }) as any;

    await expect(
      handlePageClick({ tabId: 1, point: { x: 90, y: 549 } }, () => null),
    ).resolves.toMatchObject({
      requestedTarget: { kind: 'point', point: { x: 90, y: 549 } },
      dispatchMode: 'dom',
      fallbackReason: 'page-hidden',
    });
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.filter(([, method]) => method.startsWith('Input.')),
    ).toHaveLength(0);
  });

  it('rejects explicit touch input before dispatch when the page is hidden', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (
        method === 'Runtime.evaluate' &&
        (params as any).expression === 'document.visibilityState'
      ) {
        return { result: { value: 'hidden' } };
      }
      return {};
    }) as any;

    await expect(
      handlePageClick({ tabId: 1, point: { x: 90, y: 549 }, clickMode: 'touch' }, () => null),
    ).rejects.toThrow('clickMode "touch" requires a visible page');
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.filter(([, method]) => method.startsWith('Input.')),
    ).toHaveLength(0);
  });

  it('attempts explicit trusted input without a visibility preflight', async () => {
    const evaluatedExpressions: string[] = [];
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        evaluatedExpressions.push((params as any).expression);
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      return {};
    }) as any;

    await expect(
      handlePageClick({ tabId: 1, point: { x: 90, y: 549 }, clickMode: 'mouse' }, () => null),
    ).resolves.toMatchObject({
      dispatchMode: 'trusted-input',
    });
    const inputCalls = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(([, method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([, method, params]) => [method, (params as any).type])).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved'],
      ['Input.dispatchMouseEvent', 'mousePressed'],
      ['Input.dispatchMouseEvent', 'mouseReleased'],
    ]);
    expect(evaluatedExpressions).not.toContain('document.visibilityState');
  });

  it('queries the active frame and translates trusted input into the outer viewport', async () => {
    getContainerTopFrame.mockResolvedValue({
      frameId: 'business-frame',
      url: 'https://example.test/list',
    });
    getFrameViewportTransform.mockResolvedValue({
      frameId: 'business-frame',
      url: 'https://example.test/list',
      offset: { x: 0, y: 103 },
      scale: { x: 1, y: 1 },
      viewport: { width: 393, height: 749 },
    });
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = (params as any).expression as string;
        if (expression.includes('getClickCoordsFromSelector')) {
          return {
            result: {
              value: {
                x: 196.5,
                y: 200,
                tag: 'div',
                text: '06:55',
                sourceTarget: { tag: 'div', text: '06:55' },
                strategy: 'self',
                distance: 0,
              },
            },
          };
        }
        if (expression.includes('document.elementFromPoint')) {
          return {
            result: { value: { tag: 'div', text: '06:55', selector: '.flight-time' } },
          };
        }
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      return {};
    }) as any;

    const result = await handlePageClick(
      { tabId: 1, selector: '.flight-card', clickMode: 'touch' },
      () => null,
    );

    expect(result).toMatchObject({
      frame: {
        frameId: 'business-frame',
        frameUrl: 'https://example.test/list',
        context: 'app-content',
      },
      coordinates: {
        coordinateSpace: 'active-frame',
        framePoint: { x: 196.5, y: 200 },
        outerPoint: { x: 196.5, y: 303 },
        frameOffset: { x: 0, y: 103 },
      },
      hitTarget: { tag: 'div', text: '06:55', selector: '.flight-time' },
    });
    const selectorEvaluation = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.find(
        ([, method, params]) =>
          method === 'Runtime.evaluate' &&
          String((params as any).expression).includes('getClickCoordsFromSelector'),
      );
    expect(selectorEvaluation?.[2]).toMatchObject({ contextId: 17 });
    const touchStart = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.find(
        ([, method, params]) =>
          method === 'Input.dispatchTouchEvent' && (params as any).type === 'touchStart',
      );
    expect(touchStart?.[2]).toMatchObject({ touchPoints: [{ x: 196.5, y: 303 }] });
  });

  it('bounds a stalled touch command and warns that the page state may have changed', async () => {
    vi.useFakeTimers();
    try {
      chrome.scripting.executeScript = vi.fn().mockResolvedValue([{ result: true }]);
      chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
        if (method === 'Runtime.evaluate') {
          const expression = String((params as any).expression ?? '');
          if (expression === 'document.visibilityState') {
            return { result: { value: 'visible' } };
          }
          if (expression.includes('width: window.visualViewport')) {
            return { result: { value: { width: 393, height: 852 } } };
          }
          if (expression.includes('navigator.maxTouchPoints')) {
            return { result: { value: false } };
          }
          return { result: { value: null } };
        }
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
        }
        if (method === 'Input.dispatchTouchEvent') {
          return new Promise(() => {});
        }
        return {};
      }) as any;

      const clickResult = expect(
        handlePageClick({ tabId: 1, point: { x: 90, y: 549 }, clickMode: 'touch' }, () => null),
      ).rejects.toMatchObject({
        message:
          'CDP Input.dispatchTouchEvent (touchStart) timed out after 10000ms. ' +
          'Touch input can stall on a hidden, background, or headless target; use clickMode "auto" or make the target visible. ' +
          'The page may already have changed; verify its current state before retrying.',
        pageActionFailureStage: 'dispatch-uncertain',
        pageActionAttempt: {
          action: 'page_click',
          requestedTarget: { kind: 'point', point: { x: 90, y: 549 } },
          requestedMode: 'touch',
          effectiveMode: 'touch',
          visibilityState: 'visible',
          coordinates: {
            coordinateSpace: 'outer-viewport',
            outerPoint: { x: 90, y: 549 },
          },
          dispatchMode: 'trusted-input',
          pointerType: 'touch',
          inputCommand: { method: 'Input.dispatchTouchEvent', type: 'touchStart' },
          inputSequence: { press: 'uncertain', release: 'uncertain' },
        },
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await clickResult;
      const inputCalls = vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.filter(([, method]) => method.startsWith('Input.'));
      expect(inputCalls.map(([, method, params]) => [method, (params as any).type])).toEqual([
        ['Input.dispatchTouchEvent', 'touchStart'],
        ['Input.dispatchTouchEvent', 'touchEnd'],
      ]);
      expect(releaseDebuggerLease).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a snapshot ref name separate from the DOM dispatch target', async () => {
    vi.mocked(resolveRef).mockReturnValue({
      backendNodeId: 42,
      role: 'StaticText',
      name: '搜索机票',
    });
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'button' } };
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: {
            value: {
              tag: 'div',
              text: '燃油费下调',
              sourceTarget: { tag: 'div', text: '搜索机票 燃油费下调' },
              x: 100,
              y: 200,
              strategy: 'self',
              distance: 0,
            },
          },
        };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      return {};
    }) as any;

    await expect(handlePageClick({ tabId: 1, selector: '@e40' }, () => null)).resolves.toEqual({
      clicked: true,
      tag: 'div',
      text: '搜索机票',
      requestedTarget: {
        kind: 'ref',
        selector: '@e40',
        role: 'StaticText',
        name: '搜索机票',
      },
      dispatchTarget: { tag: 'div', text: '燃油费下调' },
      dispatchMode: 'trusted-input',
      pointerType: 'mouse',
      coordinates: {
        coordinateSpace: 'outer-viewport',
        outerPoint: { x: 100, y: 200 },
      },
      resolvedTarget: {
        tag: 'div',
        text: '搜索机票 燃油费下调',
        strategy: 'self',
        distance: 0,
      },
    });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed' }),
    );
  });

  it('uses the state-aware JS path for checkbox refs by default', async () => {
    vi.mocked(resolveRef).mockReturnValue({
      backendNodeId: 43,
      role: 'checkbox',
      name: '同意协议',
    });
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'agreement' } };
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: {
            value: {
              tag: 'input',
              text: '',
              cx: 20,
              cy: 30,
              strategy: 'self',
              distance: 0,
              controlState: {
                type: 'checkbox',
                checkedBefore: false,
                checkedAfter: true,
              },
            },
          },
        };
      }
      return {};
    }) as any;

    await expect(handlePageClick({ tabId: 1, selector: '@e3' }, () => null)).resolves.toMatchObject(
      {
        controlState: {
          type: 'checkbox',
          checkedBefore: false,
          checkedAfter: true,
        },
      },
    );
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.some(([, method]) => method.startsWith('Input.')),
    ).toBe(false);
  });

  it.each([
    ['selector', 'auto'],
    ['ref', 'auto'],
    ['text', 'auto'],
    ['selector', 'mouse'],
    ['ref', 'mouse'],
    ['text', 'mouse'],
  ] as const)('dispatches native options via %s in %s mode', async (mode, clickMode) => {
    vi.mocked(resolveRef).mockReturnValue({ backendNodeId: 44, role: 'option', name: 'New' });
    const selectionState = { valueBefore: 'old', valueAfter: 'new', selectedAfter: true };
    const coords = {
      x: 20,
      y: 30,
      tag: 'select',
      text: 'Old New',
      sourceTarget: { tag: 'option', text: 'New' },
    };
    const selection = { clicked: true, tag: 'option', text: 'New', cx: 20, cy: 30, selectionState };
    let calls = 0;
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params: any) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'option' } };
      if (method === 'Accessibility.getFullAXTree')
        return {
          nodes: [{ role: { value: 'option' }, name: { value: 'New' }, backendDOMNodeId: 44 }],
        };
      if (method === 'Runtime.callFunctionOn')
        return { result: { value: calls++ === 0 ? coords : selection } };
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.visibilityState')
          return { result: { value: 'visible' } };
        return { result: { value: calls++ === 0 ? coords : selection } };
      }
      return {};
    }) as any;
    const params =
      mode === 'text'
        ? { text: 'New', role: 'option' }
        : { selector: mode === 'ref' ? '@e3' : '#target' };
    const result = await handlePageClick({ tabId: 1, ...params, clickMode }, () => null);
    if (clickMode === 'auto') {
      expect(result).toMatchObject({ tag: 'option', dispatchMode: 'dom', selectionState });
    } else {
      expect(result).toMatchObject({ dispatchMode: 'trusted-input', pointerType: 'mouse' });
      expect(result).not.toHaveProperty('selectionState');
    }
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.some(([, method]) => method.startsWith('Input.')),
    ).toBe(clickMode === 'mouse');
  });

  it('uses the state-aware JS path for checkbox CSS selectors by default', async () => {
    let evaluateCount = 0;
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        if ((params as any)?.expression === 'document.visibilityState') {
          return { result: { value: 'visible' } };
        }
        evaluateCount += 1;
        if (evaluateCount === 1) {
          return {
            result: {
              value: {
                x: 20,
                y: 30,
                tag: 'input',
                text: '',
                inputType: 'checkbox',
                strategy: 'self',
                distance: 0,
              },
            },
          };
        }
        return {
          result: {
            value: {
              clicked: true,
              tag: 'input',
              text: '',
              cx: 20,
              cy: 30,
              strategy: 'self',
              distance: 0,
              controlState: {
                type: 'checkbox',
                checkedBefore: false,
                checkedAfter: true,
              },
            },
          },
        };
      }
      return {};
    }) as any;

    await expect(
      handlePageClick({ tabId: 1, selector: '#agreement' }, () => null),
    ).resolves.toMatchObject({
      controlState: {
        type: 'checkbox',
        checkedBefore: false,
        checkedAfter: true,
      },
    });
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.some(([, method]) => method.startsWith('Input.')),
    ).toBe(false);
  });

  it('limits text matching to a CSS or ref scope', async () => {
    vi.mocked(resolveRef).mockReturnValue({
      backendNodeId: 77,
      role: 'dialog',
      name: 'Confirm purchase',
    });
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params: any) => {
      if (method === 'Accessibility.queryAXTree') {
        expect(params).toEqual({ backendNodeId: 77 });
        return {
          nodes: [
            {
              ignored: false,
              role: { value: 'button' },
              name: { value: '确定' },
              backendDOMNodeId: 42,
            },
          ],
        };
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'confirm-button' } };
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: {
            value: {
              x: 100,
              y: 200,
              tag: 'button',
              text: '确定',
              strategy: 'actionable-ancestor',
              distance: 1,
            },
          },
        };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      return {};
    }) as any;

    await expect(
      handlePageClick({ tabId: 1, text: '确定', scope: '@e12' }, () => null),
    ).resolves.toMatchObject({
      requestedTarget: { kind: 'text', name: '确定', role: 'button', scope: '@e12' },
      resolvedTarget: {
        tag: 'button',
        strategy: 'actionable-ancestor',
        distance: 1,
      },
    });
  });

  it('resolves iframe contexts without disabling a shared Runtime domain', async () => {
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({ url: 'https://example.test/frame' }),
    } as any;
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'frame result' } };
      return {};
    }) as any;

    await expect(
      handlePageEval({ tabId: 1, frameId: 'frame-1', expression: 'location.href' }, () => null),
    ).resolves.toEqual({ result: 'frame result' });
    expect(acquireDebuggerLease).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ domains: ['Runtime'] }),
    );
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.some(([, method]) => method === 'Runtime.disable'),
    ).toBe(false);
    expect(resolveDebuggerFrameExecutionContextId).toHaveBeenCalledWith(1, 'frame-1', false);
  });

  it('refreshes a stale iframe context after navigation and retries evaluation', async () => {
    resolveDebuggerFrameExecutionContextId.mockResolvedValueOnce(17).mockResolvedValueOnce(18);
    let evaluationCount = 0;
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') {
        evaluationCount += 1;
        if (evaluationCount === 1) throw new Error('Cannot find context with specified id');
        expect((params as any).contextId).toBe(18);
        return { result: { value: 'fresh frame result' } };
      }
      return {};
    }) as any;

    await expect(
      handlePageEval({ tabId: 1, frameId: 'frame-1', expression: 'location.href' }, () => null),
    ).resolves.toEqual({ result: 'fresh frame result' });
    expect(resolveDebuggerFrameExecutionContextId).toHaveBeenNthCalledWith(1, 1, 'frame-1', false);
    expect(resolveDebuggerFrameExecutionContextId).toHaveBeenNthCalledWith(2, 1, 'frame-1', true);
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.some(([, method]) => method === 'Runtime.disable'),
    ).toBe(false);
  });
});

describe('page waiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({ url: 'https://example.test/app' }),
    } as any;
    chrome.scripting = {
      executeScript: vi.fn().mockResolvedValue([{ result: true }]),
    } as any;
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({ result: { value: true } }) as any;
  });

  it('waits for a selector in the extension backend', async () => {
    await expect(
      handlePageWait({ tabId: 1, selector: '.ready', timeout: 1000 }, () => null),
    ).resolves.toMatchObject({ success: true, waited: true, mode: 'selector', value: true });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({
        expression: expect.stringContaining('const selector = ".ready"'),
      }),
    );
  });

  it('waits for selector visibility and page text', async () => {
    await expect(
      handlePageWait(
        { tabId: 1, selector: '.dialog', state: 'visible', timeout: 1000 },
        () => null,
      ),
    ).resolves.toMatchObject({ mode: 'selector', value: true });
    await expect(
      handlePageWait({ tabId: 1, text: '提交成功', timeout: 1000 }, () => null),
    ).resolves.toMatchObject({ mode: 'text', value: true });

    const expressions = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.map(([, , params]) => String((params as any)?.expression ?? ''));
    expect(expressions.some(expression => expression.includes('state = "visible"'))).toBe(true);
    expect(expressions.some(expression => expression.includes('expected = "提交成功"'))).toBe(true);
  });

  it.each([true, false])(
    'resumes before evaluating a frozen page (initially frozen: %s)',
    async initiallyFrozen => {
      let frozen = initiallyFrozen;
      let ready = false;
      chrome.tabs.get = vi.fn(async () => ({ frozen })) as any;
      chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
        if (method === 'Page.setWebLifecycleState') {
          frozen = false;
          ready = true;
          return {};
        }
        if (frozen) throw new Error('The frozen page cannot evaluate the condition');
        if (!ready) frozen = true;
        return { result: { value: ready } };
      }) as any;

      await expect(
        handlePageWait(
          { tabId: 1, selector: '#confirmation', state: 'visible', timeout: 250, interval: 20 },
          () => null,
        ),
      ).resolves.toMatchObject({ waited: true, value: true });
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'Page.setWebLifecycleState',
        { state: 'active' },
      );
      expect(vi.mocked(chrome.debugger.sendCommand).mock.calls.map(([, method]) => method)).toEqual(
        initiallyFrozen
          ? ['Page.setWebLifecycleState', 'Runtime.evaluate']
          : ['Runtime.evaluate', 'Page.setWebLifecycleState', 'Runtime.evaluate'],
      );
    },
  );

  it('evaluates conditions in the main page context', async () => {
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({
      result: { value: { ready: true, version: 2 } },
    }) as any;

    await expect(
      handlePageWait(
        { tabId: 1, condition: 'window.appReady', timeout: 1000, interval: 50 },
        () => null,
      ),
    ).resolves.toMatchObject({
      success: true,
      waited: true,
      mode: 'condition',
      value: { ready: true, version: 2 },
    });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'window.appReady', awaitPromise: true }),
    );
  });
});
