import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePageFrames, handlePageSnapshot } from '../snapshotHandlers';

const {
  acquireDebuggerLease,
  releaseDebuggerLease,
  getContainerTopFrame,
  getFrameViewportTransform,
} = vi.hoisted(() => ({
  releaseDebuggerLease: vi.fn(),
  acquireDebuggerLease: vi.fn(),
  getContainerTopFrame: vi.fn(),
  getFrameViewportTransform: vi.fn(),
}));

vi.mock('../../debuggerSessionManager', () => ({
  acquireDebuggerLease,
}));
vi.mock('../../utils/containerFrameTarget', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/containerFrameTarget')>(),
  getContainerTopFrame,
  getFrameViewportTransform,
}));

describe('extension page snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireDebuggerLease.mockResolvedValue({ release: releaseDebuggerLease });
    getContainerTopFrame.mockResolvedValue(undefined);
    getFrameViewportTransform.mockReset();
    chrome.tabs = {
      onRemoved: { addListener: vi.fn() },
      get: vi.fn().mockResolvedValue({
        id: 1,
        url: 'https://example.test/',
        title: 'Example',
      }),
    } as any;
  });

  it.each(['chrome://settings/', 'chrome-extension://test/options.html', 'devtools://devtools/'])(
    'reads %s when the browser permits it',
    async url => {
      vi.mocked(chrome.tabs.get).mockResolvedValueOnce({ id: 1, url } as chrome.tabs.Tab);
      chrome.debugger.sendCommand = vi.fn(async () => ({})) as any;
      await expect(
        handlePageSnapshot({ tabId: 1, mode: 'dom' }, () => null),
      ).resolves.toBeDefined();
      expect(acquireDebuggerLease).toHaveBeenCalledWith(1, expect.anything());
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'DOMSnapshot.captureSnapshot',
        expect.anything(),
      );
    },
  );

  it('preserves a browser attachment rejection', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
      id: 1,
      url: 'chrome://settings/',
    } as chrome.tabs.Tab);
    acquireDebuggerLease.mockRejectedValueOnce(new Error('Cannot access this target'));
    await expect(handlePageSnapshot({ tabId: 1 }, () => null)).rejects.toThrow(
      'Cannot access this target',
    );
  });

  it('includes extension and about frames in frame discovery and snapshots', async () => {
    const children = [
      { id: 'extension-child', url: 'chrome-extension://test/child.html' },
      { id: 'blank-child', url: 'about:blank' },
    ];
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params?: Record<string, any>) => {
      if (method === 'Page.getFrameTree')
        return {
          frameTree: {
            frame: { id: 'main', url: 'chrome-extension://test/page.html' },
            childFrames: children.map(frame => ({ frame })),
          },
        };
      if (method === 'Accessibility.getFullAXTree')
        return {
          nodes: [
            {
              nodeId: 'root',
              ignored: false,
              role: { value: 'button' },
              name: { value: params?.frameId ?? 'main' },
              backendDOMNodeId: 1,
            },
          ],
        };
      return {};
    }) as any;
    const { frames } = await handlePageFrames({ tabId: 1 }, () => null);
    expect(frames.map(frame => frame.frameId)).toEqual(['main', 'extension-child', 'blank-child']);
    const snapshot = await handlePageSnapshot({ tabId: 1, maxChars: 0 }, () => null);
    expect(snapshot.snapshot).toContain('extension-child');
    expect(snapshot.snapshot).toContain('blank-child');
  });

  it('returns the full AX subtree selected by rootSelector', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params?: Record<string, any>) => {
      if (method === 'Runtime.evaluate') {
        return { result: { objectId: 'dialog-object' } };
      }
      if (method === 'DOM.describeNode') {
        return { node: { backendNodeId: 30 } };
      }
      if (method === 'Accessibility.queryAXTree') {
        expect(params).toEqual({ backendNodeId: 30 });
        return {
          nodes: [
            {
              nodeId: 'dialog',
              ignored: false,
              role: { value: 'dialog' },
              name: { value: 'Confirm order' },
              backendDOMNodeId: 30,
              childIds: ['confirm'],
            },
            {
              nodeId: 'confirm',
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Confirm' },
              backendDOMNodeId: 31,
            },
          ],
        };
      }
      return {};
    }) as any;

    const result = await handlePageSnapshot(
      { tabId: 1, rootSelector: '[role="dialog"]', maxChars: 0 },
      () => null,
    );

    expect(result.snapshot).toContain('[dialog "Confirm order"]');
    expect(result.snapshot).toContain('[button "Confirm"]');
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 1 },
      'Accessibility.getPartialAXTree',
      expect.anything(),
    );
    expect(releaseDebuggerLease).toHaveBeenCalledOnce();
  });

  it('returns a rendered DOM snapshot without reading the AX tree', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          strings: ['#document', '', 'BODY', 'DIV', '#text', 'Continue', 'block', 'visible', '1'],
          documents: [
            {
              nodes: {
                parentIndex: [-1, 0, 1, 2],
                nodeType: [9, 1, 1, 3],
                nodeName: [0, 2, 3, 4],
                nodeValue: [1, 1, 1, 5],
                backendNodeId: [10, 11, 12, 13],
                attributes: [[], [], [], []],
                isClickable: { index: [2] },
              },
              layout: {
                nodeIndex: [0, 1, 2, 3],
                bounds: [
                  [0, 0, 400, 800],
                  [0, 0, 400, 800],
                  [10, 10, 200, 40],
                  [10, 10, 200, 40],
                ],
                styles: Array.from({ length: 4 }, () => [6, 7, 8]),
              },
            },
          ],
        };
      }
      return {};
    }) as any;

    const result = await handlePageSnapshot(
      { tabId: 1, mode: 'dom', query: { text: 'Continue', role: 'clickable' }, maxChars: 0 },
      () => null,
    );

    expect(result).toMatchObject({
      mode: 'dom',
      matchCount: 1,
      matches: [{ ref: expect.stringMatching(/^@e\d+$/), role: 'clickable', name: 'Continue' }],
    });
    expect(result.snapshot).toContain('[clickable "Continue"]');
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^Accessibility\./),
      expect.anything(),
    );
  });

  it('expands a snapshot ref to an ancestor and filters the local tree', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params?: Record<string, any>) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main', url: 'https://example.test/' } } };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'dialog',
              ignored: false,
              role: { value: 'dialog' },
              name: { value: 'Confirm order' },
              backendDOMNodeId: 130,
              childIds: ['confirm'],
            },
            {
              nodeId: 'confirm',
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Confirm' },
              backendDOMNodeId: 131,
            },
          ],
        };
      }
      if (method === 'DOM.resolveNode') {
        expect(params).toEqual({ backendNodeId: 131 });
        return { object: { objectId: 'confirm-object' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { objectId: 'dialog-object' } };
      }
      if (method === 'DOM.describeNode') {
        expect(params).toEqual({ objectId: 'dialog-object' });
        return { node: { backendNodeId: 130 } };
      }
      if (method === 'Accessibility.queryAXTree') {
        expect(params).toEqual({ backendNodeId: 130 });
        return {
          nodes: [
            {
              nodeId: 'dialog',
              ignored: false,
              role: { value: 'dialog' },
              name: { value: 'Confirm order' },
              backendDOMNodeId: 130,
              childIds: ['confirm'],
            },
            {
              nodeId: 'confirm',
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Confirm' },
              backendDOMNodeId: 131,
            },
          ],
        };
      }
      return {};
    }) as any;

    const baseline = await handlePageSnapshot({ tabId: 1, maxChars: 0 }, () => null);
    const buttonRef = baseline.snapshot.match(/(@e\d+) \[button "Confirm"\]/)?.[1];
    expect(buttonRef).toBeDefined();

    const result = await handlePageSnapshot(
      {
        tabId: 1,
        rootRef: buttonRef,
        ancestorDepth: 1,
        query: { text: 'Confirm', role: 'button' },
        maxChars: 0,
      },
      () => null,
    );

    expect(result).toMatchObject({
      rootRef: buttonRef,
      ancestorDepth: 1,
      matchCount: 1,
      matches: [{ ref: expect.stringMatching(/^@e\d+$/), role: 'button', name: 'Confirm' }],
    });
    expect(result.matches?.[0].ref).not.toBe(buttonRef);
    expect(result.snapshot).toContain('[dialog "Confirm order"]');
    expect(result.snapshot).toContain('[button "Confirm"]');
  });

  it('reports the live DOM checked state when the AX cache is stale', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params?: Record<string, any>) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main', url: 'https://example.test/' } } };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Login' },
              backendDOMNodeId: 40,
              childIds: ['agreement'],
            },
            {
              nodeId: 'agreement',
              ignored: false,
              role: { value: 'checkbox' },
              name: { value: 'Accept terms' },
              backendDOMNodeId: 41,
              properties: [{ name: 'checked', value: { value: false } }],
            },
          ],
        };
      }
      if (method === 'DOM.resolveNode') {
        expect(params).toEqual({ backendNodeId: 41 });
        return { object: { objectId: 'agreement-object' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: true } };
      }
      return {};
    }) as any;

    const result = await handlePageSnapshot(
      { tabId: 1, query: { role: 'checkbox' }, maxChars: 0 },
      () => null,
    );

    expect(result.snapshot).toContain('[checkbox "Accept terms"] (checked)');
    expect(result.matches).toEqual([
      expect.objectContaining({ role: 'checkbox', name: 'Accept terms', checked: true }),
    ]);
  });

  it('uses the DOM snapshot coordinate space when CSS metrics are scaled', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === 'Page.getLayoutMetrics') {
        return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 196.5, clientHeight: 426 },
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 393, clientHeight: 852 },
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          documents: [
            {
              nodes: { backendNodeId: [50, 51, 52] },
              layout: {
                nodeIndex: [0, 1, 2],
                bounds: [
                  [0, 0, 393, 852],
                  [243, 194, 14, 19],
                  [26, 471, 20, 19],
                ],
              },
            },
          ],
        };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main', url: 'https://example.test/' } } };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Calendar' },
              backendDOMNodeId: 50,
              childIds: ['right-column', 'lower-row'],
            },
            {
              nodeId: 'right-column',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Thursday' },
              backendDOMNodeId: 51,
            },
            {
              nodeId: 'lower-row',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Later date' },
              backendDOMNodeId: 52,
            },
          ],
        };
      }
      return {};
    }) as any;

    const result = await handlePageSnapshot(
      { tabId: 1, mode: 'viewport', maxChars: 0 },
      () => null,
    );

    expect(result.snapshot).toContain('Thursday');
    expect(result.snapshot).toContain('Later date');
    expect(result).toMatchObject({
      outerViewport: { width: 196.5, height: 426 },
      contentViewport: { x: 0, y: 0, width: 196.5, height: 426 },
    });
  });

  it('filters a container snapshot with the business frame viewport', async () => {
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
      if (method === 'Page.getLayoutMetrics') {
        return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 393, clientHeight: 852 },
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 786, clientHeight: 1704 },
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          strings: ['business-frame', 'block', 'visible', '1'],
          documents: [
            {
              frameId: 0,
              scrollOffsetX: 0,
              scrollOffsetY: 0,
              nodes: { backendNodeId: [50, 51, 52] },
              layout: {
                nodeIndex: [0, 1, 2],
                bounds: [
                  [0, 0, 786, 2800],
                  [0, 1350, 786, 180],
                  [0, 1548, 786, 200],
                ],
                styles: [
                  [1, 2, 3],
                  [1, 2, 3],
                  [1, 2, 3],
                ],
              },
            },
          ],
        };
      }
      if (method === 'Accessibility.getFullAXTree') {
        expect(params).toMatchObject({ frameId: 'business-frame' });
        return {
          nodes: [
            {
              nodeId: 'root',
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Flights' },
              backendDOMNodeId: 50,
              childIds: ['visible', 'offscreen'],
            },
            {
              nodeId: 'visible',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Visible flight' },
              backendDOMNodeId: 51,
            },
            {
              nodeId: 'offscreen',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Offscreen flight' },
              backendDOMNodeId: 52,
            },
          ],
        };
      }
      return {};
    }) as any;

    const result = await handlePageSnapshot(
      { tabId: 1, mode: 'viewport', maxChars: 0 },
      () => null,
    );

    expect(result.snapshot).toContain('Visible flight');
    expect(result.snapshot).not.toContain('Offscreen flight');
    expect(result).toMatchObject({
      outerViewport: { width: 393, height: 852 },
      contentViewport: { x: 0, y: 103, width: 393, height: 749 },
      scrollX: 0,
      scrollY: 0,
    });
  });

  it('excludes offscreen semantic controls from interactive mode', async () => {
    chrome.debugger.sendCommand = vi.fn(async (_target, method) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          documents: [
            {
              nodes: { backendNodeId: [10, 11, 12] },
              layout: {
                nodeIndex: [0, 1],
                bounds: [
                  [0, 0, 800, 600],
                  [10, 10, 120, 40],
                ],
              },
            },
          ],
        };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main', url: 'https://example.test/' } } };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Search' },
              backendDOMNodeId: 10,
              childIds: ['visible', 'offscreen'],
            },
            {
              nodeId: 'visible',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Visible summary' },
              backendDOMNodeId: 11,
            },
            {
              nodeId: 'offscreen',
              ignored: false,
              role: { value: 'textbox' },
              name: { value: 'Hidden picker input' },
              backendDOMNodeId: 12,
            },
          ],
        };
      }
      return {};
    }) as any;

    const result = await handlePageSnapshot(
      { tabId: 1, mode: 'interactive', query: { role: 'textbox' }, maxChars: 0 },
      () => null,
    );

    expect(result).toMatchObject({ mode: 'interactive', fallbackMode: 'viewport' });
    expect(result.snapshot).toBe('(no matches)');
    expect(result.matchCount).toBe(0);
  });
});
