import { describe, expect, it } from 'vitest';
import {
  buildPageInspectExpression,
  inspectElementsInPage,
  resolvePageInspectInput,
} from '../domInspection';

describe('page inspect input', () => {
  it('applies bounded defaults for selector inspection', () => {
    expect(resolvePageInspectInput({ tabId: 1, selector: '.card' })).toEqual({
      selector: '.card',
      filter: 'all',
      maxResults: 20,
      styles: ['display', 'position', 'box-sizing', 'overflow-x', 'overflow-y'],
      includeOuterHTML: false,
    });
  });

  it('supports page-wide overflow diagnostics and rejects an unbounded query', () => {
    expect(
      resolvePageInspectInput({
        tabId: 1,
        filter: 'horizontal-overflow',
        maxResults: 5,
        styles: [],
      }),
    ).toEqual({
      filter: 'horizontal-overflow',
      maxResults: 5,
      styles: [],
      includeOuterHTML: false,
    });
    expect(() => resolvePageInspectInput({ tabId: 1 })).toThrow('requires "selector"');
  });

  it('accepts the DevTools selection locator and includes its markup by default', () => {
    expect(resolvePageInspectInput({ tabId: 1, selector: '$0' })).toMatchObject({
      selector: '$0',
      includeOuterHTML: true,
    });
  });

  it('builds a document expression with the normalized options', () => {
    const expression = buildPageInspectExpression(
      resolvePageInspectInput({ tabId: 1, selector: '.list', styles: ['display'] }),
    );

    expect(expression).toContain('inspect.call');
    expect(expression).toContain('".list"');
    expect(expression).toContain('["display"]');
  });
});

describe('inspectElementsInPage', () => {
  function inspectControl(
    attributes: Record<string, string>,
    properties: Record<string, any> = {},
  ) {
    const element: any = {
      nodeType: 1,
      tagName: 'DIV',
      children: [],
      getAttribute: (name: string) => attributes[name] ?? null,
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }),
      ...properties,
    };
    const document: any = {
      nodeType: 9,
      querySelectorAll: () => [element],
      defaultView: { getComputedStyle: () => ({}) },
    };
    element.ownerDocument = document;
    const expression = buildPageInspectExpression(
      resolvePageInspectInput({ tabId: 1, selector: '#control' }),
    );
    return new Function('document', `return ${expression}`)(document).matches[0];
  }

  it('keeps native checked and mixed state authoritative with provenance', () => {
    expect(
      inspectControl(
        { 'aria-checked': 'true' },
        {
          tagName: 'INPUT',
          type: 'checkbox',
          checked: false,
        },
      ).state.checked,
    ).toEqual({ value: false, source: 'native' });
    expect(
      inspectControl(
        {},
        {
          tagName: 'INPUT',
          type: 'checkbox',
          checked: false,
          indeterminate: true,
        },
      ).state.checked,
    ).toEqual({ value: 'mixed', source: 'native' });
    expect(inspectControl({ 'aria-checked': 'mixed', 'aria-expanded': 'false' }).state).toEqual({
      checked: { value: 'mixed', source: 'aria' },
      expanded: { value: false, source: 'aria' },
    });
    expect(
      inspectControl({ 'aria-disabled': 'true' }, { tagName: 'BUTTON' }).state.disabled,
    ).toEqual({ value: true, source: 'aria' });
  });

  it('keeps state unknown when only presentation attributes are available', () => {
    expect(inspectControl({ class: 'checked', 'data-state': 'checked' }).state).toBeUndefined();
  });

  it('reports native readonly only for controls where it applies', () => {
    for (const type of ['text', 'date']) {
      expect(inspectControl({}, { tagName: 'INPUT', type, readOnly: true }).state.readonly).toEqual(
        { value: true, source: 'native' },
      );
    }
    expect(inspectControl({}, { tagName: 'TEXTAREA', readOnly: false }).state.readonly).toEqual({
      value: false,
      source: 'native',
    });
    for (const type of ['checkbox', 'hidden', 'range']) {
      expect(
        inspectControl({}, { tagName: 'INPUT', type, readOnly: true }).state.readonly,
      ).toBeUndefined();
    }
    expect(
      inspectControl({ 'aria-readonly': 'true' }, { tagName: 'INPUT', type: 'checkbox' }).state
        .readonly,
    ).toEqual({ value: true, source: 'aria' });
  });

  it('reports overflow size, border box, styles, and the nearest scroll container', () => {
    const document: any = { nodeType: 9 };
    const container: any = {
      nodeType: 1,
      tagName: 'DIV',
      id: 'scroller',
      children: [],
      parentElement: null,
      scrollWidth: 320,
      scrollHeight: 900,
      clientWidth: 320,
      clientHeight: 400,
      scrollLeft: 0,
      scrollTop: 120,
      ownerDocument: document,
    };
    const child: any = {
      nodeType: 1,
      tagName: 'DIV',
      id: '',
      children: [],
      parentElement: container,
      scrollWidth: 380,
      scrollHeight: 40,
      clientWidth: 300,
      clientHeight: 40,
      scrollLeft: 0,
      scrollTop: 0,
      ownerDocument: document,
      innerText: 'Wide row',
      outerHTML: '<div class="row">Wide row</div>',
      isConnected: true,
      contains: (node: any) => node === child,
      getBoundingClientRect: () => ({
        x: 10,
        y: 20,
        width: 300,
        height: 40,
        top: 20,
        right: 310,
        bottom: 60,
        left: 10,
      }),
    };
    container.children = [child];
    document.documentElement = container;
    document.querySelectorAll = (selector: string) => {
      if (selector === '#scroller') return [container];
      if (selector === '.items') return [child, child, child];
      return selector === '*' || selector === '.row' ? [child] : [];
    };
    document.defaultView = {
      innerWidth: 320,
      innerHeight: 640,
      getComputedStyle: (element: any) => {
        const values =
          element === container
            ? { display: 'block', position: 'fixed', overflowX: 'hidden', overflowY: 'auto' }
            : {
                display: 'block',
                position: 'relative',
                overflowX: 'visible',
                overflowY: 'visible',
              };
        return {
          ...values,
          visibility: 'visible',
          opacity: '1',
          getPropertyValue: (property: string) =>
            ({
              display: values.display,
              position: values.position,
              'overflow-x': values.overflowX,
              'overflow-y': values.overflowY,
            })[property] ?? '',
        };
      },
    };
    document.elementFromPoint = () => child;

    expect(
      inspectElementsInPage.call(
        document,
        undefined,
        'horizontal-overflow',
        ['display', 'position'],
        20,
        'Use a native selector.',
      ),
    ).toEqual({
      filter: 'horizontal-overflow',
      candidateCount: 1,
      count: 1,
      truncated: false,
      matches: [
        expect.objectContaining({
          tag: 'div',
          text: 'Wide row',
          visible: true,
          hitTest: expect.objectContaining({ topmost: true, receivesPointerEvents: true }),
          boundingBox: expect.objectContaining({ width: 300, height: 40 }),
          computedStyle: { display: 'block', position: 'relative' },
          scroll: expect.objectContaining({ horizontalOverflow: 80, verticalOverflow: 0 }),
          scrollContainer: expect.objectContaining({
            selector: '#scroller',
            ancestorDistance: 1,
            scrollTop: 120,
          }),
        }),
      ],
    });

    expect(
      inspectElementsInPage.call(document, '.items', 'all', [], 1, 'Use a native selector.'),
    ).toMatchObject({
      selector: '.items',
      candidateCount: 3,
      count: 3,
      matches: [{ text: 'Wide row' }],
      truncated: true,
    });
  });

  it('reports the element covering the inspected target', () => {
    const document: any = { nodeType: 9 };
    const target: any = {
      nodeType: 1,
      tagName: 'BUTTON',
      children: [],
      ownerDocument: document,
      scrollWidth: 100,
      scrollHeight: 40,
      clientWidth: 100,
      clientHeight: 40,
      innerText: 'Continue',
      contains: (node: any) => node === target,
      getBoundingClientRect: () => ({
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        top: 20,
        right: 110,
        bottom: 60,
        left: 10,
      }),
    };
    const overlay: any = {
      nodeType: 1,
      tagName: 'DIV',
      id: 'dialog-mask',
      children: [],
      ownerDocument: document,
      innerText: '',
    };
    document.documentElement = target;
    document.querySelectorAll = (selector: string) =>
      selector === '.target' ? [target] : selector === '#dialog-mask' ? [overlay] : [];
    document.elementFromPoint = () => overlay;
    document.defaultView = {
      innerWidth: 320,
      innerHeight: 640,
      getComputedStyle: () => ({
        display: 'block',
        position: 'relative',
        visibility: 'visible',
        opacity: '1',
        pointerEvents: 'auto',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    };

    expect(inspectElementsInPage.call(document, '.target', 'all', [], 1, 'hint')).toMatchObject({
      matches: [
        {
          hitTest: {
            topmost: false,
            receivesPointerEvents: false,
            occludedBy: { selector: '#dialog-mask', tag: 'div' },
          },
        },
      ],
    });
  });
});
