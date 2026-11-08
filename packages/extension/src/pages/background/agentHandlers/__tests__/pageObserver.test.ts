import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposePageObserverInPage,
  installPageObserverInPage,
  samplePageReadinessInPage,
} from '@mearl/browser-core';

const containerMocks = vi.hoisted(() => ({
  getContainerTopFrame: vi.fn(),
}));

vi.mock('../../debuggerSessionManager', () => ({
  acquireDebuggerLease: vi.fn().mockResolvedValue({ release: vi.fn() }),
  resolveDebuggerFrameExecutionContextId: vi.fn().mockResolvedValue(17),
}));
vi.mock('../../utils/containerFrameTarget', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/containerFrameTarget')>(),
  getContainerTopFrame: containerMocks.getContainerTopFrame,
}));
vi.mock('../snapshotHandlers', () => ({ resolveRef: vi.fn() }));

import {
  detectExtensionContainerNavigation,
  disposeExtensionPageObservation,
  finishExtensionPageObservation,
  startExtensionPageObservation,
} from '../interactionHandlers';

const GLOBAL_KEY = '__MEARL_PAGE_OBSERVER__';
const READINESS_GLOBAL_KEY = '__MEARL_READINESS_OBSERVER__';

function observerState(): any {
  return (globalThis as any)[GLOBAL_KEY];
}

function waitSince(checkpoint: { version: number; focus?: string }, quietMs = 10): Promise<any> {
  return observerState().waitSince(checkpoint.version, checkpoint.focus, quietMs, 100, 1000);
}

describe('page action observer', () => {
  beforeEach(() => {
    observerState()?.observer?.disconnect();
    (globalThis as any)[READINESS_GLOBAL_KEY]?.observer?.disconnect();
    delete (globalThis as any)[GLOBAL_KEY];
    delete (globalThis as any)[READINESS_GLOBAL_KEY];
    document.body.innerHTML = '<main id="stage"></main>';
    containerMocks.getContainerTopFrame.mockReset().mockResolvedValue(undefined);
    chrome.scripting = {
      executeScript: vi.fn(async ({ func, args }: any) => [
        { result: await func(...(args ?? [])) },
      ]),
    } as any;
  });

  afterEach(() => {
    observerState()?.observer?.disconnect();
    (globalThis as any)[READINESS_GLOBAL_KEY]?.observer?.disconnect();
    delete (globalThis as any)[GLOBAL_KEY];
    delete (globalThis as any)[READINESS_GLOBAL_KEY];
    delete (document as any).getAnimations;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not depend on page timers when finishing observation in a background tab', async () => {
    chrome.tabs = { get: vi.fn().mockResolvedValue({ active: false }) } as any;
    const checkpoint = await startExtensionPageObservation(1);

    await expect(
      finishExtensionPageObservation(1, checkpoint, {
        quietMs: 20,
        firstChangeTimeoutMs: 100,
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ mode: 'delta', settledBy: 'no-change', changed: false });
    const finishCall = vi.mocked(chrome.scripting.executeScript).mock.calls.at(-1)?.[0] as any;
    expect(finishCall.args.at(-1)).toBe(0);
  });

  it('bounds a frozen background observation in the service worker', async () => {
    vi.useFakeTimers();
    chrome.tabs = { get: vi.fn().mockResolvedValue({ active: false }) } as any;
    chrome.scripting.executeScript = vi.fn(() => new Promise(() => {})) as any;
    const result = finishExtensionPageObservation(
      1,
      {
        version: 0,
        url: 'https://example.test/start',
        title: 'Start',
        world: 'scripting',
      },
      { timeoutMs: 3000 },
    );
    const rejection = expect(result).rejects.toThrow('Page observation deadline exceeded');

    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
  });

  it('passes the service-worker deadline into a container CDP evaluation', async () => {
    const originalAddListener = chrome.debugger.onEvent.addListener;
    const originalSendCommand = chrome.debugger.sendCommand;
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({
        active: true,
        url: 'https://container.test/start',
        title: 'Start',
      }),
    } as any;
    containerMocks.getContainerTopFrame.mockResolvedValue({
      frameId: 'root',
      url: 'https://example.test/start',
    });
    chrome.debugger.onEvent.addListener = vi.fn((listener: (...args: any[]) => void) => {
      listener({ tabId: 1 }, 'Runtime.executionContextCreated', {
        context: { id: 17, auxData: { frameId: 'root', isDefault: true } },
      });
    });
    chrome.debugger.sendCommand = vi.fn(async (_target, method, _params) => {
      if (method !== 'Runtime.evaluate') return {};
      return {
        result: {
          value: {
            mode: 'delta',
            scope: 'main-document',
            checkpoint: 0,
            version: 0,
            elapsed: 0,
            settledBy: 'no-change',
            url: 'https://example.test/start',
            title: 'Start',
            changed: false,
            effects: { notifications: [], interactives: [] },
            mutationCount: 0,
            overflow: false,
            fullSnapshotRecommended: false,
            snapshotReasons: [],
          },
        },
      };
    }) as any;

    try {
      await finishExtensionPageObservation(
        1,
        {
          version: 0,
          url: 'https://example.test/start',
          title: 'Start',
          world: 'cdp',
          containerFrameId: 'root',
          containerUrl: 'https://container.test/start',
        },
        { timeoutMs: 3000 },
      );

      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'Runtime.evaluate',
        expect.objectContaining({ contextId: 17, awaitPromise: true, timeout: 5000 }),
      );
    } finally {
      chrome.debugger.onEvent.addListener = originalAddListener;
      chrome.debugger.sendCommand = originalSendCommand;
    }
  });

  it('reports navigation after another container WebView becomes active', async () => {
    chrome.tabs = { get: vi.fn().mockResolvedValue({ active: false }) } as any;
    containerMocks.getContainerTopFrame.mockResolvedValue({
      frameId: 'layer-1',
      url: 'https://example.test/next',
    });
    const checkpoint = {
      version: 0,
      url: 'https://example.test/start',
      title: 'Start',
      world: 'cdp' as const,
      containerFrameId: 'root',
    };

    await expect(finishExtensionPageObservation(1, checkpoint)).resolves.toMatchObject({
      mode: 'navigation',
      urlBefore: 'https://example.test/start',
      urlAfter: 'https://example.test/next',
      settledBy: 'load',
    });
    await expect(disposeExtensionPageObservation(1, 'cdp', 'root')).resolves.toBeUndefined();
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('uses the container-owned URL before querying a transient frame tree', async () => {
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({
        active: false,
        url: 'https://example.test/next',
        title: 'Next page',
      }),
    } as any;

    await expect(
      finishExtensionPageObservation(1, {
        version: 0,
        url: 'https://example.test/start',
        title: 'Start',
        world: 'cdp',
        containerFrameId: 'root',
        containerUrl: 'https://container.test/start',
      }),
    ).resolves.toMatchObject({
      mode: 'navigation',
      urlAfter: 'https://example.test/next',
      title: 'Next page',
    });
    await expect(
      disposeExtensionPageObservation(1, 'cdp', 'root', 'https://container.test/start'),
    ).resolves.toBeUndefined();
    expect(containerMocks.getContainerTopFrame).not.toHaveBeenCalled();
  });

  it('waits for a newly created container WebView to leave about:blank', async () => {
    chrome.tabs = { get: vi.fn().mockResolvedValue({ active: false, title: 'Next page' }) } as any;
    containerMocks.getContainerTopFrame
      .mockResolvedValueOnce({ frameId: 'layer-1', url: 'about:blank' })
      .mockResolvedValue({ frameId: 'layer-1', url: 'https://example.test/next' });

    await expect(
      finishExtensionPageObservation(1, {
        version: 0,
        url: 'https://example.test/start',
        title: 'Start',
        world: 'cdp',
        containerFrameId: 'root',
      }),
    ).resolves.toMatchObject({
      mode: 'navigation',
      urlAfter: 'https://example.test/next',
    });
  });

  it('detects a container WebView created during navigation grace', async () => {
    vi.useFakeTimers();
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({ active: false, title: 'Next page' }),
    } as any;
    containerMocks.getContainerTopFrame
      .mockResolvedValueOnce({ frameId: 'root', url: 'https://example.test/start' })
      .mockResolvedValue({ frameId: 'layer-1', url: 'https://example.test/next' });
    const result = detectExtensionContainerNavigation(
      1,
      {
        version: 0,
        url: 'https://example.test/start',
        title: 'Start',
        world: 'cdp',
        containerFrameId: 'root',
      },
      1000,
    );

    await vi.advanceTimersByTimeAsync(51);
    await expect(result).resolves.toMatchObject({
      mode: 'navigation',
      urlAfter: 'https://example.test/next',
      title: 'Next page',
    });
  });

  it('polls the container-owned URL without reentering CDP during navigation grace', async () => {
    vi.useFakeTimers();
    chrome.tabs = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ active: false, url: 'https://container.test/start' })
        .mockResolvedValue({
          active: false,
          url: 'https://example.test/next',
          title: 'Next page',
        }),
    } as any;
    const result = detectExtensionContainerNavigation(
      1,
      {
        version: 0,
        url: 'https://example.test/start',
        title: 'Start',
        world: 'cdp',
        containerFrameId: 'root',
        containerUrl: 'https://container.test/start',
      },
      1000,
    );

    await vi.advanceTimersByTimeAsync(51);
    await expect(result).resolves.toMatchObject({
      mode: 'navigation',
      urlAfter: 'https://example.test/next',
    });
    expect(containerMocks.getContainerTopFrame).not.toHaveBeenCalled();
  });

  it('blocks content-stable readiness while a visible skeleton remains', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 20,
    } as DOMRect);
    document.body.innerHTML = '<button>A</button><button>B</button><button>C</button>';
    expect(samplePageReadinessInPage(0).ready).toBe(true);

    const skeleton = document.createElement('div');
    skeleton.className = 'result-skeleton';
    document.body.appendChild(skeleton);
    expect(samplePageReadinessInPage(0)).toEqual(
      expect.objectContaining({ ready: false, skeletonVisible: true }),
    );
  });

  it('retains a status notification that disappears during the action', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint, 30);
    const toast = document.createElement('div');
    toast.id = 'save-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = '保存成功';

    document.body.appendChild(toast);
    await new Promise(resolve => setTimeout(resolve, 0));
    toast.remove();
    const result = await resultPromise;

    expect(result.effects.notifications).toEqual([
      expect.objectContaining({
        change: 'transient',
        node: expect.objectContaining({ role: 'status', name: '保存成功' }),
        duration: expect.any(Number),
      }),
    ]);
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it('recognizes a hidden toast without emitting its child text as separate effects', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint, 30);
    const toast = document.createElement('div');
    toast.id = 'request-toast';
    toast.className = 'toast';
    toast.innerHTML = '<span>请求失败</span><span>请重试</span>';

    document.body.appendChild(toast);
    await new Promise(resolve => setTimeout(resolve, 0));
    toast.style.display = 'none';
    const result = await resultPromise;

    expect(result.effects.notifications).toHaveLength(1);
    expect(result.effects.notifications[0]).toEqual(
      expect.objectContaining({
        change: 'transient',
        node: expect.objectContaining({ selector: '#request-toast', name: '请求失败请重试' }),
      }),
    );
  });

  it('returns only newly actionable controls for a classified DOM change', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    const button = document.createElement('button');
    button.id = 'continue';
    button.textContent = '继续';
    document.querySelector('#stage')!.appendChild(button);

    const result = await resultPromise;
    expect(result.effects.interactives).toEqual([
      expect.objectContaining({
        change: 'appeared',
        node: expect.objectContaining({ selector: '#continue', role: 'button', name: '继续' }),
      }),
    ]);
    expect(result.snapshotReasons).toEqual([]);
  });

  it('distinguishes a semantic control remount from a newly appeared control', async () => {
    const input = document.createElement('input');
    input.id = 'flight-query';
    input.setAttribute('aria-label', '搜索航班');
    document.querySelector('#stage')!.appendChild(input);
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);

    const replacement = input.cloneNode(true);
    input.replaceWith(replacement);

    const result = await resultPromise;
    expect(result.effects.interactives).toEqual([
      expect.objectContaining({
        change: 'recreated',
        node: expect.objectContaining({
          selector: '#flight-query',
          role: 'textbox',
          name: '搜索航班',
        }),
      }),
    ]);
  });

  it('does not recommend a snapshot when a rendered form is replaced with identical content', async () => {
    const form = document.createElement('section');
    form.innerHTML = [
      '<span>Flight details</span>',
      '<input id="flight-number" aria-label="Flight number" value="CA123">',
    ].join('');
    document.querySelector('#stage')!.appendChild(form);
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);

    form.replaceWith(form.cloneNode(true));

    const result = await resultPromise;
    expect(result.effects.interactives).toEqual([
      expect.objectContaining({
        change: 'recreated',
        node: expect.objectContaining({ selector: '#flight-number', role: 'textbox' }),
      }),
    ]);
    expect(result.effects.interactives[0].node).not.toHaveProperty('value');
    expect(result.snapshotReasons).toEqual([]);
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it('compacts an unchanged control remounted across mutation batches', async () => {
    const input = document.createElement('input');
    input.id = 'booking-reference';
    input.setAttribute('aria-label', 'Booking reference');
    input.value = 'ABC123';
    document.querySelector('#stage')!.appendChild(input);
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint, 30);
    const replacement = input.cloneNode(true);

    input.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('#stage')!.appendChild(replacement);

    const result = await resultPromise;
    expect(result.effects.interactives).toEqual([
      {
        change: 'recreated',
        node: {
          selector: '#booking-reference',
          tag: 'input',
          role: 'textbox',
          name: 'Booking reference',
        },
      },
    ]);
  });

  it('keeps changed values when a control is remounted', async () => {
    const input = document.createElement('input');
    input.id = 'flight-number';
    input.setAttribute('aria-label', 'Flight number');
    input.value = 'CA123';
    document.querySelector('#stage')!.appendChild(input);
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    const replacement = input.cloneNode(true) as HTMLInputElement;
    replacement.value = 'CA456';

    input.replaceWith(replacement);

    const result = await resultPromise;
    expect(result.effects.interactives).toEqual([
      expect.objectContaining({
        change: 'recreated',
        node: expect.objectContaining({ selector: '#flight-number', value: 'CA456' }),
      }),
    ]);
  });

  it('does not report controls inside a CSS-hidden ancestor as actionable', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    const hiddenPanel = document.createElement('section');
    hiddenPanel.style.display = 'none';
    hiddenPanel.innerHTML = '<button id="hidden-action">Hidden action</button>';
    document.querySelector('#stage')!.appendChild(hiddenPanel);

    const result = await resultPromise;

    expect(result.effects.interactives).toEqual([]);
    expect(result.changed).toBe(true);
  });

  it('recommends a snapshot only for unclassified structural content', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    document.querySelector('#stage')!.textContent = 'Loaded text';

    const result = await resultPromise;
    expect(result.effects).toEqual({ notifications: [], interactives: [] });
    expect(result.snapshotReasons).toEqual(['unclassified-structure']);
    expect(result.fullSnapshotRecommended).toBe(true);
  });

  it('keeps unclassified result text visible even when the same change adds a textbox', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    const search = document.createElement('section');
    search.innerHTML = [
      '<input id="city-query" aria-label="搜索城市">',
      '<div class="city-result">上海（所有机场）</div>',
    ].join('');
    document.querySelector('#stage')!.appendChild(search);

    const result = await resultPromise;
    expect(result.effects.interactives).toEqual([
      expect.objectContaining({ node: expect.objectContaining({ selector: '#city-query' }) }),
    ]);
    expect(result.snapshotReasons).toContain('unclassified-structure');
  });

  it('does not duplicate a newly focused control in interactive effects', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    const input = document.createElement('input');
    input.id = 'focused-query';
    input.setAttribute('aria-label', '搜索');
    document.querySelector('#stage')!.appendChild(input);
    input.focus();

    const result = await resultPromise;

    expect(result.effects.focus).toEqual(
      expect.objectContaining({ selector: '#focused-query', focused: true }),
    );
    expect(result.effects.interactives).toEqual([]);
  });

  it('does not turn class-only animation noise into semantic output or a fallback', async () => {
    const label = document.createElement('span');
    label.id = 'label';
    label.textContent = 'Existing content';
    document.querySelector('#stage')!.appendChild(label);
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    label.className = 'slide-enter-active';

    const result = await resultPromise;
    expect(result.changed).toBe(true);
    expect(result.effects).toEqual({ notifications: [], interactives: [] });
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it('waits for a finite page animation before reporting DOM quiet', async () => {
    vi.useFakeTimers();
    const stage = document.querySelector('#stage')!;
    let animationChecks = 0;
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value: vi.fn(() => {
        animationChecks += 1;
        if (animationChecks > 1) return [];
        return [
          {
            playState: 'running',
            currentTime: 0,
            effect: {
              target: stage,
              getComputedTiming: () => ({ iterations: 1, endTime: 60 }),
            },
          },
        ];
      }),
    });
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint, 10);
    stage.className = 'sheet-enter-active';
    await Promise.resolve();

    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(80);

    await expect(resultPromise).resolves.toMatchObject({ settledBy: 'quiet', changed: true });
    expect(animationChecks).toBeGreaterThanOrEqual(2);
  });

  it('does not let an infinite page animation block DOM quiet', async () => {
    const stage = document.querySelector('#stage')!;
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value: vi.fn(() => [
        {
          playState: 'running',
          currentTime: 100,
          effect: {
            target: stage,
            getComputedTiming: () => ({ iterations: Infinity, endTime: Infinity }),
          },
        },
      ]),
    });
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint, 10);
    stage.className = 'spinner-running';

    await expect(resultPromise).resolves.toMatchObject({ settledBy: 'quiet', changed: true });
  });

  it('bounds large mutation batches and reports overflow', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 600; index += 1) {
      const item = document.createElement('div');
      item.textContent = `Calendar ${index}`;
      fragment.appendChild(item);
    }
    document.querySelector('#stage')!.appendChild(fragment);

    const result = await resultPromise;
    expect(result.overflow).toBe(true);
    expect(result.snapshotReasons).toEqual(
      expect.arrayContaining(['observation-overflow', 'unclassified-structure']),
    );
  });

  it('keeps password values out of interactive effects', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    const form = document.createElement('form');
    form.innerHTML = [
      '<input id="query" aria-label="Query" value="flight">',
      '<input id="secret" type="password" aria-label="Secret" value="do-not-return">',
    ].join('');
    document.querySelector('#stage')!.appendChild(form);

    const result = await resultPromise;
    const query = result.effects.interactives.find(
      (effect: any) => effect.node.selector === '#query',
    );
    const secret = result.effects.interactives.find(
      (effect: any) => effect.node.selector === '#secret',
    );
    expect(query.node.value).toBe('flight');
    expect(secret.node).not.toHaveProperty('value');
  });

  it('transports the compact result through chrome.scripting', async () => {
    const checkpoint = await startExtensionPageObservation(1);
    const resultPromise = finishExtensionPageObservation(1, checkpoint, {
      quietMs: 10,
      firstChangeTimeoutMs: 100,
      timeoutMs: 500,
    });
    const button = document.createElement('button');
    button.id = 'async-ready';
    button.textContent = 'Ready';
    document.querySelector('#stage')!.appendChild(button);

    const result = await resultPromise;
    expect(checkpoint.world).toBe('scripting');
    expect(result.mode).toBe('delta');
    if (result.mode !== 'delta') throw new Error('Expected a same-document observation');
    expect(result.effects.interactives[0].node.selector).toBe('#async-ready');
    for (const [call] of vi.mocked(chrome.scripting.executeScript).mock.calls) {
      expect(String((call as any).func)).not.toContain('new Function');
    }
  });

  it('disconnects the page observer after an action completes', async () => {
    installPageObserverInPage();
    const state = observerState();
    disposePageObserverInPage();
    document.querySelector('#stage')!.appendChild(document.createElement('button'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect((globalThis as any)[GLOBAL_KEY]).toBeUndefined();
    expect(state.version).toBe(0);
  });

  it('ignores DevTools overlay mutations without requesting a snapshot', async () => {
    const checkpoint = installPageObserverInPage();
    const resultPromise = waitSince(checkpoint);
    const overlay = document.createElement('div');
    overlay.setAttribute('data-mearl-overlay', 'click-indicator');
    document.body.appendChild(overlay);

    const result = await resultPromise;
    expect(result.settledBy).toBe('no-change');
    expect(result.changed).toBe(false);
    expect(result.fullSnapshotRecommended).toBe(false);
  });
});
