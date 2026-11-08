import { describe, expect, it, vi } from 'vitest';
import {
  cdpPageClick,
  cdpPageDrag,
  cdpPageEval,
  cdpPageInspect,
  cdpPageNavigate,
  cdpPagePress,
  cdpPageScroll,
  cdpPageUpload,
  cdpPageWait,
  cdpSetDeviceEmulation,
} from '../interaction-handlers';
import { getPageRefRegistry } from '../page-refs';

describe('native CDP interaction handlers', () => {
  it('runs structured DOM inspection without an accessibility snapshot', async () => {
    const value = {
      selector: '.card',
      filter: 'all',
      candidateCount: 2,
      count: 2,
      matches: [],
      truncated: true,
    };
    const sendCommand = vi.fn(async (method: string) =>
      method === 'Runtime.evaluate' ? { result: { value } } : {},
    );
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(cdpPageInspect(session, { tabId: 1, selector: '.card' })).resolves.toEqual(value);
    expect(sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('querySelectorAll') }),
    );
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Accessibility.'))).toBe(
      false,
    );
  });

  it('rejects frame-relative clicks instead of using the outer document', async () => {
    const session = { client: { sendCommand: vi.fn(), on: vi.fn(() => () => {}) } } as any;

    await expect(
      cdpPageClick(session, {
        point: { x: 20, y: 30 },
        coordinateSpace: 'active-frame',
      }),
    ).rejects.toThrow('require the browser extension backend');
  });

  it('classifies a stale snapshot ref before dispatching input', async () => {
    const sendCommand = vi.fn();
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(
      cdpPageClick(session, { selector: '@e9801', clickMode: 'dom' }),
    ).rejects.toMatchObject({
      message: 'Ref @e9801 not found. Run page_snapshot first to get fresh refs.',
      pageActionFailureStage: 'precondition',
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('dispatches paired key events with normalized modifiers', async () => {
    const sendCommand = vi.fn(async (method: string, params: any) => {
      if (method === 'Runtime.evaluate' && params.expression === 'document.visibilityState') {
        return { result: { value: 'visible' } };
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(
      cdpPagePress(session, {
        tabId: 1,
        key: 'Enter',
        modifiers: ['ctrl', 'Shift'],
      }),
    ).resolves.toEqual({ pressed: true, key: 'Enter', dispatchMode: 'trusted-input' });
    expect(
      sendCommand.mock.calls
        .filter(([method]) => method === 'Input.dispatchKeyEvent')
        .map(([, params]) => [params.type, params.code, params.modifiers]),
    ).toEqual([
      ['keyDown', 'Enter', 10],
      ['keyUp', 'Enter', 10],
    ]);
  });

  it('uses DOM keyboard simulation automatically on a hidden page', async () => {
    const domResult = {
      pressed: true,
      target: { tag: 'button' },
      keydownCanceled: false,
      defaultAction: 'click',
    };
    const sendCommand = vi.fn(async (method: string, params: any) => {
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: params.expression === 'document.visibilityState' ? 'hidden' : domResult,
          },
        };
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(cdpPagePress(session, { tabId: 1, key: 'Enter' })).resolves.toEqual({
      ...domResult,
      key: 'Enter',
      dispatchMode: 'dom',
      fallbackReason: 'page-hidden',
    });
    expect(sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchKeyEvent')).toBe(
      false,
    );
  });

  it('classifies keyboard acknowledgement timeouts after queuing key release', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Input.dispatchKeyEvent') {
        throw new Error('CDP command timeout: Input.dispatchKeyEvent');
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(
      cdpPagePress(session, { tabId: 1, key: 'Escape', pressMode: 'keyboard' }),
    ).rejects.toMatchObject({ pageActionFailureStage: 'dispatch-uncertain' });
    expect(
      sendCommand.mock.calls
        .filter(([method]) => method === 'Input.dispatchKeyEvent')
        .map(([, params]) => params.type),
    ).toEqual(['keyDown', 'keyUp']);
  });

  it('dispatches a segmented mouse drag with the button held', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 430, height: 932 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 430, clientHeight: 932 } };
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(
      cdpPageDrag(session, {
        from: { x: 350, y: 80 },
        to: { x: 80, y: 80 },
        dragMode: 'mouse',
        durationMs: 0,
      }),
    ).resolves.toMatchObject({
      dragged: true,
      pointerType: 'mouse',
      durationMs: 0,
      steps: 2,
    });

    const inputCalls = sendCommand.mock.calls.filter(([method]) => method.startsWith('Input.'));
    expect(inputCalls.map(([method, params]) => [method, params.type, params.buttons])).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved', undefined],
      ['Input.dispatchMouseEvent', 'mousePressed', 1],
      ['Input.dispatchMouseEvent', 'mouseMoved', 1],
      ['Input.dispatchMouseEvent', 'mouseMoved', 1],
      ['Input.dispatchMouseEvent', 'mouseReleased', 0],
    ]);
    expect(inputCalls.at(-1)?.[1]).toMatchObject({ x: 80, y: 80 });
  });

  it('uses touchStart, touchMove, and touchEnd for mobile drag input', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      return {};
    });
    const session = {
      client: { sendCommand, on: vi.fn(() => () => {}) },
      emulation: { mobile: true, touch: true },
    } as any;

    await expect(
      cdpPageDrag(session, {
        from: { x: 320, y: 100 },
        to: { x: 90, y: 100 },
        durationMs: 0,
      }),
    ).resolves.toMatchObject({ pointerType: 'touch', steps: 2 });
    expect(
      sendCommand.mock.calls
        .filter(([method]) => method.startsWith('Input.'))
        .map(([method, params]) => [method, params.type]),
    ).toEqual([
      ['Input.dispatchTouchEvent', 'touchStart'],
      ['Input.dispatchTouchEvent', 'touchMove'],
      ['Input.dispatchTouchEvent', 'touchMove'],
      ['Input.dispatchTouchEvent', 'touchEnd'],
    ]);
  });

  it('uses DOM simulation for an auto drag in a hidden tab', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate') {
        if (params?.expression === 'document.visibilityState') {
          return { result: { value: 'hidden' } };
        }
        if (params?.expression.includes('navigator.maxTouchPoints')) {
          return { result: { value: false } };
        }
        if (params?.expression.includes('elementFromPoint')) {
          return { result: { value: { dragged: true, steps: 2 } } };
        }
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(
      cdpPageDrag(session, {
        from: { x: 350, y: 80 },
        to: { x: 80, y: 80 },
        durationMs: 0,
      }),
    ).resolves.toMatchObject({
      dragged: true,
      dispatchMode: 'dom',
      pointerType: 'mouse',
      fallbackReason: 'page-hidden',
      steps: 2,
    });
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  });

  it('uses real CDP input for a generic snapshot ref by default', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'search' } };
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: {
            value: {
              x: 120,
              y: 44,
              tag: 'div',
              text: '搜索',
              strategy: 'self',
              distance: 0,
            },
          },
        };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 390, clientHeight: 844 } };
      }
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: params.expression.includes('maxTouchPoints')
              ? false
              : { width: 390, height: 844 },
          },
        };
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;
    const ref = getPageRefRegistry(session).registerDelta({
      backendNodeId: 42,
      role: 'StaticText',
      name: '搜索',
    });

    await expect(cdpPageClick(session, { selector: ref })).resolves.toMatchObject({
      requestedTarget: { kind: 'ref', role: 'StaticText', name: '搜索' },
      tag: 'div',
      text: '搜索',
    });
    expect(sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed' }),
      10_000,
    );
  });

  it('uses trusted touch input when the page session has mobile emulation', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate' && params.expression === 'document.visibilityState') {
        return { result: { value: 'visible' } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      return {};
    });
    const session = {
      client: { sendCommand, on: vi.fn(() => () => {}) },
      emulation: { mobile: true, touch: true },
    } as any;

    await expect(cdpPageClick(session, { point: { x: 90, y: 549 } })).resolves.toMatchObject({
      dispatchMode: 'trusted-input',
      pointerType: 'touch',
    });
    expect(
      sendCommand.mock.calls
        .filter(([method]) => method.startsWith('Input.'))
        .map(([method, params]) => [method, params.type]),
    ).toEqual([
      ['Input.dispatchTouchEvent', 'touchStart'],
      ['Input.dispatchTouchEvent', 'touchEnd'],
    ]);
  });

  it('uses the DOM fallback immediately when the page is hidden', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate' && params.expression === 'document.visibilityState') {
        return { result: { value: 'hidden' } };
      }
      if (
        method === 'Runtime.evaluate' &&
        params.expression.includes('Cannot resolve clickable element')
      ) {
        return {
          result: {
            value: {
              clicked: true,
              tag: 'div',
              text: 'Open panel',
              strategy: 'self',
              distance: 0,
            },
          },
        };
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(cdpPageClick(session, { selector: '.panel-trigger' })).resolves.toMatchObject({
      clicked: true,
      dispatchMode: 'dom',
      fallbackReason: 'page-hidden',
    });
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  });

  it('rejects a disabled option reached by a DOM point click', async () => {
    const session = { client: { sendCommand: vi.fn(async () => ({
      result: { value: { error: 'Cannot select a disabled option' } },
    })), on: vi.fn(() => () => {}) } } as any;
    await expect(cdpPageClick(session, {
      point: { x: 20, y: 30 }, clickMode: 'dom',
    })).rejects.toMatchObject({ pageActionFailureStage: 'precondition' });
  });

  it('uses the DOM fallback for point clicks on a hidden page', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate' && params.expression === 'document.visibilityState') {
        return { result: { value: 'hidden' } };
      }
      if (
        method === 'Runtime.evaluate' &&
        params.expression.includes('document.elementFromPoint')
      ) {
        return {
          result: {
            value: {
              tag: 'button',
              text: 'Continue',
              strategy: 'self',
              distance: 0,
            },
          },
        };
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(cdpPageClick(session, { point: { x: 90, y: 549 } })).resolves.toMatchObject({
      requestedTarget: { kind: 'point', point: { x: 90, y: 549 } },
      dispatchMode: 'dom',
      fallbackReason: 'page-hidden',
    });
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  });

  it('rejects explicit touch input before dispatch when the page is hidden', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate' && params.expression === 'document.visibilityState') {
        return { result: { value: 'hidden' } };
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(
      cdpPageClick(session, { point: { x: 90, y: 549 }, clickMode: 'touch' }),
    ).rejects.toThrow('clickMode "touch" requires a visible page');
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  });

  it('attempts explicit trusted input without a visibility preflight', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      if (method === 'Runtime.evaluate' && params.expression.includes('width:')) {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: false } };
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(
      cdpPageClick(session, {
        point: { x: 90, y: 549 },
        clickMode: 'mouse',
      }),
    ).resolves.toMatchObject({
      dispatchMode: 'trusted-input',
    });
    expect(
      sendCommand.mock.calls
        .filter(([method]) => method.startsWith('Input.'))
        .map(([method, params]) => [method, params.type]),
    ).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved'],
      ['Input.dispatchMouseEvent', 'mousePressed'],
      ['Input.dispatchMouseEvent', 'mouseReleased'],
    ]);
    expect(
      sendCommand.mock.calls.some(
        ([method, params]) =>
          method === 'Runtime.evaluate' && params.expression === 'document.visibilityState',
      ),
    ).toBe(false);
  });

  it('preserves resolved click evidence when trusted input acknowledgement is uncertain', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 393, clientHeight: 852 } };
      }
      if (method === 'Runtime.evaluate' && params.expression.includes('width:')) {
        return { result: { value: { width: 393, height: 852 } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: false } };
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        throw new Error('CDP command timeout: Input.dispatchMouseEvent');
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(
      cdpPageClick(session, {
        point: { x: 90, y: 549 },
        clickMode: 'mouse',
      }),
    ).rejects.toMatchObject({
      pageActionFailureStage: 'dispatch-uncertain',
      pageActionAttempt: {
        action: 'page_click',
        requestedTarget: { kind: 'point', point: { x: 90, y: 549 } },
        requestedMode: 'mouse',
        effectiveMode: 'mouse',
        coordinates: {
          coordinateSpace: 'outer-viewport',
          outerPoint: { x: 90, y: 549 },
        },
        dispatchMode: 'trusted-input',
        pointerType: 'mouse',
        inputCommand: { method: 'Input.dispatchMouseEvent', type: 'mousePressed' },
        inputSequence: { press: 'uncertain', release: 'acknowledged' },
      },
    });
  });

  it('uses the state-aware JS path for checkbox refs by default', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'agreement' } };
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: {
            value: {
              tag: 'input',
              text: '',
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
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;
    const ref = getPageRefRegistry(session).registerDelta({
      backendNodeId: 43,
      role: 'checkbox',
      name: '同意协议',
    });

    await expect(cdpPageClick(session, { selector: ref })).resolves.toMatchObject({
      controlState: {
        type: 'checkbox',
        checkedBefore: false,
        checkedAfter: true,
      },
    });
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
    expect(
      sendCommand.mock.calls.filter(([method]) => method === 'Runtime.callFunctionOn'),
    ).toHaveLength(1);
  });

  it.each([
    ['selector', 'auto'], ['ref', 'auto'], ['text', 'auto'],
    ['selector', 'mouse'], ['ref', 'mouse'], ['text', 'mouse'],
  ] as const)('dispatches native options via %s in %s mode', async (mode, clickMode) => {
    const selectionState = { valueBefore: 'old', valueAfter: 'new', selectedAfter: true };
    const coords = { x: 20, y: 30, tag: 'select', text: 'Old New', sourceTarget: { tag: 'option', text: 'New' } };
    const selection = { tag: 'option', text: 'New', selectionState };
    let backendCalls = 0;
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'option' } };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [
        { role: { value: 'option' }, name: { value: 'New' }, backendDOMNodeId: 44 },
      ] };
      if (method === 'Runtime.callFunctionOn') return { result: { value: backendCalls++ === 0 ? coords : selection } };
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.visibilityState') return { result: { value: 'visible' } };
        if (params.expression.includes('Cannot resolve element coordinates')) return { result: { value: coords } };
        if (params.expression.includes('Cannot resolve clickable element')) return { result: { value: selection } };
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;
    const ref = getPageRefRegistry(session).registerDelta({ backendNodeId: 44, role: 'option', name: 'New' });
    const params = mode === 'text' ? { text: 'New', role: 'option' }
      : { selector: mode === 'ref' ? ref : '#target' };
    const result = await cdpPageClick(session, { ...params, clickMode });
    if (clickMode === 'auto') {
      expect(result).toMatchObject({ tag: 'option', dispatchMode: 'dom', selectionState });
    } else {
      expect(result).toMatchObject({ dispatchMode: 'trusted-input', pointerType: 'mouse' });
      expect(result).not.toHaveProperty('selectionState');
    }
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.')))
      .toBe(clickMode === 'mouse');
  });

  it('preserves controlState for checkbox selectors on the adaptive JS path', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('Cannot resolve clickable element')) {
          return {
            result: {
              value: {
                clicked: true,
                tag: 'input',
                text: '',
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
        if (params.expression.includes('Cannot resolve element coordinates')) {
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
      }
      return {};
    });
    const session = { client: { sendCommand, on: vi.fn(() => () => {}) } } as any;

    await expect(cdpPageClick(session, { selector: '#agreement' })).resolves.toMatchObject({
      controlState: {
        type: 'checkbox',
        checkedBefore: false,
        checkedAfter: true,
      },
    });
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  });

  it('navigates browser history through the structured page_navigate contract', async () => {
    let currentIndex = 1;
    const entries = [
      { id: 10, url: 'https://example.test/home', title: 'Home' },
      { id: 11, url: 'https://example.test/login', title: 'Login' },
    ];
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.getNavigationHistory') return { currentIndex, entries };
      if (method === 'Page.navigateToHistoryEntry') {
        expect(params).toEqual({ entryId: 10 });
        currentIndex = 0;
        return {};
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.readyState') {
          return { result: { value: 'complete' } };
        }
        return {
          result: {
            value: { url: 'https://example.test/home', title: 'Home' },
          },
        };
      }
      return {};
    });
    const session = { client: { sendCommand } } as any;

    await expect(cdpPageNavigate(session, { history: 'back' })).resolves.toEqual({
      success: true,
      url: 'https://example.test/home',
      title: 'Home',
      history: 'back',
    });
  });

  it('reports a missing browser history entry', async () => {
    const sendCommand = vi.fn(async () => ({
      currentIndex: 0,
      entries: [{ id: 10, url: 'https://example.test/home', title: 'Home' }],
    }));

    await expect(
      cdpPageNavigate({ client: { sendCommand } } as any, { history: 'back' }),
    ).rejects.toThrow('no previous history entry');
  });

  it('uses the public direction and distance contract for scrolling', async () => {
    const sendCommand = vi.fn(async (method: string, _params?: any) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { scrollY: 600, scrollHeight: 2400 } } };
      }
      return {};
    });

    await expect(
      cdpPageScroll({ client: { sendCommand } } as any, {
        direction: 'down',
        distance: 600,
      }),
    ).resolves.toEqual({ scrollY: 600, scrollHeight: 2400 });
    expect(sendCommand.mock.calls[0][1].expression).toContain(
      "scroll.call(document, dir, dist, 'page', policy)",
    );
  });

  it('scrolls a container selected by CSS', async () => {
    const sendCommand = vi.fn(async (method: string, _params?: any) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { scrollY: 800, scrollHeight: 2400 } } };
      }
      return {};
    });

    await expect(
      cdpPageScroll({ client: { sendCommand } } as any, {
        selector: '.virtual-list',
        direction: 'down',
        distance: 800,
      }),
    ).resolves.toEqual({ scrollY: 800, scrollHeight: 2400 });
    expect(sendCommand.mock.calls[0][1].expression).toContain('const sel = ".virtual-list"');
    expect(sendCommand.mock.calls[0][1].expression).toContain(
      'return scroll.call(el, dir, dist, sel, policy)',
    );
  });

  it('scrolls a container selected by snapshot ref', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'DOM.resolveNode') {
        expect(params).toEqual({ backendNodeId: 42 });
        return { object: { objectId: 'list' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        expect(params).toMatchObject({
          objectId: 'list',
          arguments: [{ value: 'bottom' }, { value: 600 }, { value: '@e1' }, { value: 'self' }],
        });
        return { result: { value: { scrollY: 2400, scrollHeight: 2400 } } };
      }
      return {};
    });
    const session = {
      client: { sendCommand, on: vi.fn(() => () => {}) },
    } as any;
    getPageRefRegistry(session).registerDelta({
      backendNodeId: 42,
      role: 'list',
      name: 'Results',
    });

    await expect(
      cdpPageScroll(session, {
        selector: '@e1',
        direction: 'bottom',
      }),
    ).resolves.toEqual({ scrollY: 2400, scrollHeight: 2400 });
  });

  it('limits text matching to a snapshot ref scope', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Accessibility.queryAXTree') {
        expect(params).toEqual({ backendNodeId: 77 });
        return {
          nodes: [
            {
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Confirm' },
              backendDOMNodeId: 42,
            },
          ],
        };
      }
      if (method === 'DOM.resolveNode') {
        expect(params).toEqual({ backendNodeId: 42 });
        return { object: { objectId: 'confirm-button' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: {
            value: {
              x: 100,
              y: 200,
              tag: 'button',
              text: 'Confirm',
              strategy: 'actionable-ancestor',
              distance: 1,
            },
          },
        };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'Runtime.evaluate') {
        if (params?.expression.includes('visualViewport')) {
          return { result: { value: { width: 800, height: 600 } } };
        }
        return { result: { value: false } };
      }
      return {};
    });
    const session = {
      client: { sendCommand, on: vi.fn(() => () => {}) },
    } as any;
    const scopeRef = getPageRefRegistry(session).registerDelta({
      backendNodeId: 77,
      role: 'dialog',
      name: 'Confirmation',
    });

    await expect(
      cdpPageClick(session, { text: 'Confirm', scope: scopeRef }),
    ).resolves.toMatchObject({
      requestedTarget: {
        kind: 'text',
        name: 'Confirm',
        role: 'button',
        scope: scopeRef,
      },
      resolvedTarget: {
        tag: 'button',
        strategy: 'actionable-ancestor',
        distance: 1,
      },
    });
  });

  it('uploads through a snapshot ref and returns the shared response shape', async () => {
    const sendCommand = vi.fn(async (method: string, params: any) => {
      if (method === 'DOM.describeNode') {
        expect(params).toEqual({ backendNodeId: 42 });
        return { node: { backendNodeId: 42, nodeName: 'INPUT' } };
      }
      return {};
    });
    const session = {
      client: { sendCommand, on: vi.fn(() => () => {}) },
    } as any;
    getPageRefRegistry(session).registerDelta({
      backendNodeId: 42,
      role: 'textbox',
      name: 'Upload',
    });

    await expect(
      cdpPageUpload(session, { selector: '@e1', filePaths: ['/tmp/ticket.pdf'] }),
    ).resolves.toEqual({ uploaded: true, fileCount: 1, tag: 'input' });
    expect(sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', {
      files: ['/tmp/ticket.pdf'],
      backendNodeId: 42,
    });
  });

  it('clears page refs before an emulation reload', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.reload') throw new Error('reload interrupted');
      return {};
    });
    const session = {
      client: { sendCommand, on: vi.fn(() => () => {}) },
    } as any;
    const registry = getPageRefRegistry(session);
    const ref = registry.registerDelta({
      backendNodeId: 42,
      role: 'button',
      name: 'Continue',
    });

    await expect(
      cdpSetDeviceEmulation(session, { enabled: true, preset: 'iphone-15-pro' }),
    ).resolves.toMatchObject({ enabled: true, reloaded: false });
    expect(registry.resolve(ref)).toBeUndefined();
    expect(session.emulation).toMatchObject({
      mobile: true,
      touch: true,
      deviceShell: false,
      config: { presetName: 'iphone-15-pro' },
    });

    await expect(cdpSetDeviceEmulation(session, { enabled: false })).resolves.toEqual({
      enabled: false,
      deviceShell: false,
      splitScreen: false,
      reloaded: false,
    });
    expect(session.emulation).toBeUndefined();
  });

  it('forces a reload when the device shell iframe is enabled or removed', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        expect(params.source).toContain('data-mearl-root-webview');
        return { identifier: 'device-shell-script' };
      }
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top', name: '', url: 'https://example.test/' },
            childFrames: [
              {
                frame: {
                  id: 'root',
                  name: '__mearl_root__',
                  url: 'https://example.test/',
                },
              },
            ],
          },
        };
      }
      if (method === 'Runtime.evaluate') return { result: { value: 'complete' } };
      return {};
    });
    const session = {
      client: { sendCommand, on: vi.fn(() => () => {}) },
    } as any;

    await expect(
      cdpSetDeviceEmulation(session, {
        enabled: true,
        preset: 'iphone-15-pro',
        deviceShell: true,
        reload: false,
      }),
    ).resolves.toMatchObject({ enabled: true, deviceShell: true, reloaded: true });
    expect(sendCommand).toHaveBeenCalledWith('Page.reload', {});

    sendCommand.mockClear();
    await expect(
      cdpSetDeviceEmulation(session, { enabled: false, reload: false }),
    ).resolves.toEqual({
      enabled: false,
      deviceShell: false,
      splitScreen: false,
      reloaded: true,
    });
    expect(sendCommand).toHaveBeenCalledWith('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: 'device-shell-script',
    });
    expect(sendCommand).toHaveBeenCalledWith('Page.reload', {});
  });

  it('waits for selectors and conditions with the shared response shape', async () => {
    const sendCommand = vi.fn(async (_method: string, params?: any) => ({
      result: {
        value: params?.expression.includes('querySelector') ? true : { ready: true },
      },
    }));
    const session = { client: { sendCommand } } as any;

    await expect(cdpPageWait(session, { selector: '.ready' })).resolves.toMatchObject({
      success: true,
      waited: true,
      mode: 'selector',
      value: true,
    });
    await expect(cdpPageWait(session, { condition: 'window.ready' })).resolves.toMatchObject({
      success: true,
      waited: true,
      mode: 'condition',
      value: { ready: true },
    });
    await expect(cdpPageWait(session, { text: '提交成功' })).resolves.toMatchObject({
      success: true,
      waited: true,
      mode: 'text',
      value: true,
    });
  });

  it('awaits page_eval promises by default', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ result: { value: 'done' } });

    await cdpPageEval({ client: { sendCommand } } as any, { expression: 'Promise.resolve()' });

    expect(sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ awaitPromise: true }),
    );
  });

  it('uses a named isolated world for plugin page scripts', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 23 };
      return { result: { value: 42 } };
    });
    const result = await cdpPageEval({ client: { sendCommand } } as any, {
      tabId: 7,
      expression: 'value => Promise.resolve(value)',
      args: [42],
      executionWorld: 'isolated',
      worldId: 'design-overlay',
    });
    expect(result).toEqual({ result: 42 });
    expect(sendCommand).toHaveBeenCalledWith('Page.createIsolatedWorld', {
      frameId: 'root',
      worldName: 'mearl-design-overlay',
    });
    expect(sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        contextId: 23,
        awaitPromise: true,
        expression: '(value => Promise.resolve(value))(...JSON.parse("[42]"))',
      }),
    );
  });
});
