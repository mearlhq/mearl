import { describe, expect, it, vi } from 'vitest';
import { cdpPageSnapshot } from '../snapshot-handlers';
import { getPageRefRegistry } from '../page-refs';

describe('native CDP snapshot refs', () => {
  it('returns a rendered DOM snapshot without reading the AX tree', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          strings: [
            '#document',
            '',
            'BODY',
            'BUTTON',
            '#text',
            'Continue',
            'block',
            'visible',
            '1',
          ],
          documents: [
            {
              nodes: {
                parentIndex: [-1, 0, 1, 2],
                nodeType: [9, 1, 1, 3],
                nodeName: [0, 2, 3, 4],
                nodeValue: [1, 1, 1, 5],
                backendNodeId: [10, 11, 12, 13],
                attributes: [[], [], [], []],
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
    });

    const result = await cdpPageSnapshot(
      { client: { sendCommand, on: vi.fn(() => () => {}) } } as any,
      { mode: 'dom', query: { text: 'Continue', role: 'button' }, maxChars: 0 },
    );

    expect(result).toMatchObject({
      mode: 'dom',
      matchCount: 1,
      matches: [{ ref: expect.stringMatching(/^@e\d+$/), role: 'button', name: 'Continue' }],
    });
    expect(result.snapshot).toContain('[button "Continue"]');
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Accessibility\./),
      expect.anything(),
    );
  });

  it('returns the full AX subtree selected by rootSelector', async () => {
    const sendCommand = vi.fn(async (method: string, params?: Record<string, any>) => {
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
    });

    const result = await cdpPageSnapshot(
      { client: { sendCommand, on: vi.fn(() => () => {}) } } as any,
      {
        rootSelector: '[role="dialog"]',
        maxChars: 0,
      },
    );

    expect(result.snapshot).toContain('[dialog "Confirm order"]');
    expect(result.snapshot).toContain('[button "Confirm"]');
    expect(sendCommand).not.toHaveBeenCalledWith(
      'Accessibility.getPartialAXTree',
      expect.anything(),
    );
  });

  it('expands a snapshot ref to an ancestor and filters the local tree', async () => {
    const sendCommand = vi.fn(async (method: string, params?: Record<string, any>) => {
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
    });
    const session = {
      client: { sendCommand, on: vi.fn(() => () => {}) },
    } as any;
    const rootRef = getPageRefRegistry(session).registerDelta({
      backendNodeId: 131,
      role: 'button',
      name: 'Confirm',
    });

    const result = await cdpPageSnapshot(session, {
      rootRef,
      ancestorDepth: 1,
      query: { text: 'Confirm', role: 'button' },
      maxChars: 0,
    });

    expect(result).toMatchObject({
      rootRef,
      ancestorDepth: 1,
      matchCount: 1,
      matches: [{ ref: expect.stringMatching(/^@e\d+$/), role: 'button', name: 'Confirm' }],
    });
    expect(result.matches[0].ref).not.toBe(rootRef);
    expect(result.snapshot).toContain('[dialog "Confirm order"]');
    expect(result.snapshot).toContain('[button "Confirm"]');
  });

  it('retains scoped snapshot refs internally without exposing backend node mappings', async () => {
    const sendCommand = vi.fn(async (method: string) => {
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
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Flights' },
              backendDOMNodeId: 10,
              childIds: ['visible', 'offscreen'],
            },
            {
              nodeId: 'visible',
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Visible' },
              backendDOMNodeId: 11,
            },
            {
              nodeId: 'offscreen',
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Offscreen' },
              backendDOMNodeId: 12,
            },
          ],
        };
      }
      return {};
    });
    const session = {
      client: { sendCommand, on: vi.fn(() => () => {}) },
    } as any;

    const result = await cdpPageSnapshot(session, { mode: 'viewport', maxChars: 0 });

    expect(result.snapshot).toContain('Visible');
    expect(result.snapshot).not.toContain('Offscreen');
    expect(result).not.toHaveProperty('refs');
    expect(getPageRefRegistry(session).resolve('@e1')).toBeDefined();
    expect(getPageRefRegistry(session).resolve('@e2')).toBeUndefined();
    expect(getPageRefRegistry(session).resolve('@e3')).toBeDefined();
  });

  it('falls back to the viewport when interactive mode has no semantic controls', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          documents: [
            {
              nodes: { backendNodeId: [20, 21] },
              layout: {
                nodeIndex: [0, 1],
                bounds: [
                  [0, 0, 800, 600],
                  [20, 20, 100, 30],
                ],
              },
            },
          ],
        };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Role-poor app' },
              backendDOMNodeId: 20,
              childIds: ['tap'],
            },
            {
              nodeId: 'tap',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Tap me' },
              backendDOMNodeId: 21,
            },
          ],
        };
      }
      return {};
    });

    const result = await cdpPageSnapshot(
      { client: { sendCommand, on: vi.fn(() => () => {}) } } as any,
      {
        mode: 'interactive',
        maxChars: 0,
      },
    );

    expect(result).toEqual(
      expect.objectContaining({ mode: 'interactive', fallbackMode: 'viewport' }),
    );
    expect(result.snapshot).toContain('Tap me');
  });

  it('uses the DOM snapshot coordinate space when CSS metrics are scaled', async () => {
    const sendCommand = vi.fn(async (method: string) => {
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
    });

    const result = await cdpPageSnapshot(
      { client: { sendCommand, on: vi.fn(() => () => {}) } } as any,
      { mode: 'viewport', maxChars: 0 },
    );

    expect(result.snapshot).toContain('Thursday');
    expect(result.snapshot).toContain('Later date');
  });

  it('excludes offscreen semantic controls from interactive mode', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          documents: [
            {
              nodes: { backendNodeId: [30, 31, 32] },
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
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'root',
              ignored: false,
              role: { value: 'RootWebArea' },
              name: { value: 'Search' },
              backendDOMNodeId: 30,
              childIds: ['visible', 'offscreen'],
            },
            {
              nodeId: 'visible',
              ignored: false,
              role: { value: 'StaticText' },
              name: { value: 'Visible summary' },
              backendDOMNodeId: 31,
            },
            {
              nodeId: 'offscreen',
              ignored: false,
              role: { value: 'textbox' },
              name: { value: 'Hidden picker input' },
              backendDOMNodeId: 32,
            },
          ],
        };
      }
      return {};
    });

    const result = await cdpPageSnapshot(
      { client: { sendCommand, on: vi.fn(() => () => {}) } } as any,
      {
        mode: 'interactive',
        query: { role: 'textbox' },
        maxChars: 0,
      },
    );

    expect(result).toMatchObject({ mode: 'interactive', fallbackMode: 'viewport' });
    expect(result.snapshot).toBe('(no matches)');
    expect(result.matchCount).toBe(0);
  });

  it('reports the live DOM checked state when the AX cache is stale', async () => {
    const sendCommand = vi.fn(async (method: string, params?: Record<string, any>) => {
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
    });

    const result = await cdpPageSnapshot(
      { client: { sendCommand, on: vi.fn(() => () => {}) } } as any,
      { query: { role: 'checkbox' }, maxChars: 0 },
    );

    expect(result.snapshot).toContain('[checkbox "Accept terms"] (checked)');
    expect(result.matches).toEqual([
      expect.objectContaining({ role: 'checkbox', name: 'Accept terms', checked: true }),
    ]);
  });
});
