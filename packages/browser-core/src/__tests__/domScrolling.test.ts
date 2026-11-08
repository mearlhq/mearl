import { describe, expect, it } from 'vitest';
import {
  buildPageScrollExpression,
  resolvePageScrollInput,
  scrollElementInPage,
} from '../domScrolling';

function createScrollableElement(
  overrides: Partial<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    overflowY: string;
    isConnected: boolean;
    scrollTo: (options: { top: number; left: number; behavior: string }) => void;
  }> = {},
): any {
  const element: any = {
    nodeType: 1,
    scrollTop: overrides.scrollTop ?? 100,
    scrollHeight: overrides.scrollHeight ?? 1000,
    clientHeight: overrides.clientHeight ?? 200,
    isConnected: overrides.isConnected ?? true,
  };
  if (overrides.scrollTo) element.scrollTo = overrides.scrollTo;
  const ownerDocument: any = {
    scrollingElement: null,
    defaultView: {
      getComputedStyle: () => ({ overflowY: overrides.overflowY ?? 'auto' }),
    },
  };
  element.ownerDocument = ownerDocument;
  return element;
}

describe('page scroll input', () => {
  it('applies the public defaults and normalizes distance', () => {
    expect(resolvePageScrollInput({ direction: 'down' })).toEqual({
      direction: 'down',
      distance: 600,
      containerPolicy: 'self',
    });
    expect(resolvePageScrollInput({ direction: 'up', distance: -240, selector: '.list' })).toEqual({
      direction: 'up',
      distance: 240,
      selector: '.list',
      containerPolicy: 'self',
    });
    expect(resolvePageScrollInput({ direction: 'down', containerPolicy: 'nearest' })).toEqual({
      direction: 'down',
      distance: 600,
      containerPolicy: 'nearest',
    });
  });

  it('rejects invalid direction, distance, and snapshot refs', () => {
    expect(() => resolvePageScrollInput({ direction: 'left' })).toThrow('Invalid direction');
    expect(() => resolvePageScrollInput({ direction: 'down', distance: '600' })).toThrow(
      '"distance" must be a finite number',
    );
    expect(() => resolvePageScrollInput({ direction: 'down', selector: 'e3' })).toThrow(
      'missing the "@" prefix',
    );
    expect(() =>
      resolvePageScrollInput({ direction: 'down', containerPolicy: 'document' }),
    ).toThrow('"containerPolicy" must be one of self, nearest');
  });

  it('builds one expression for page and selector targets', () => {
    const pageExpression = buildPageScrollExpression(resolvePageScrollInput({ direction: 'down' }));
    const selectorExpression = buildPageScrollExpression(
      resolvePageScrollInput({ direction: 'bottom', selector: '.virtual-list' }),
    );

    expect(pageExpression).toContain("scroll.call(document, dir, dist, 'page', policy)");
    expect(selectorExpression).toContain('const sel = ".virtual-list"');
    expect(selectorExpression).toContain('return scroll.call(el, dir, dist, sel, policy)');
  });
});

describe('scrollElementInPage', () => {
  it('scrolls a container synchronously and clamps to its range', () => {
    const element = createScrollableElement();

    expect(scrollElementInPage.call(element, 'down', 600, '.list')).toEqual({
      scrollY: 700,
      scrollHeight: 1000,
      clientHeight: 200,
      maxScrollY: 800,
      scrollYBefore: 100,
      scrollYAfter: 700,
      moved: true,
      atTop: false,
      atBottom: false,
      target: '.list',
      resolvedContainer: 'self',
      ancestorDistance: 0,
    });
    expect(element.scrollTop).toBe(700);

    expect(scrollElementInPage.call(element, 'bottom', 600, '.list')).toEqual({
      scrollY: 800,
      scrollHeight: 1000,
      clientHeight: 200,
      maxScrollY: 800,
      scrollYBefore: 700,
      scrollYAfter: 800,
      moved: true,
      atTop: false,
      atBottom: true,
      target: '.list',
      resolvedContainer: 'self',
      ancestorDistance: 0,
    });
    expect(element.scrollTop).toBe(800);
  });

  it('overrides CSS smooth scrolling with an instant scroll before reading the result', () => {
    const calls: Array<{ top: number; left: number; behavior: string }> = [];
    const element = createScrollableElement({
      scrollTop: 0,
      scrollTo(options) {
        calls.push(options);
        this.scrollTop = options.top;
      },
    });

    expect(scrollElementInPage.call(element, 'down', 700, 'page')).toMatchObject({
      scrollYBefore: 0,
      scrollYAfter: 700,
      moved: true,
    });
    expect(calls).toEqual([{ top: 700, left: 0, behavior: 'instant' }]);
  });

  it('resolves text nodes to their parent scroll container', () => {
    const element = createScrollableElement({ scrollTop: 400 });
    const textNode = { nodeType: 3, parentElement: element };

    expect(scrollElementInPage.call(textNode, 'up', 250, '@e3')).toEqual({
      scrollY: 150,
      scrollHeight: 1000,
      clientHeight: 200,
      maxScrollY: 800,
      scrollYBefore: 400,
      scrollYAfter: 150,
      moved: true,
      atTop: false,
      atBottom: false,
      target: '@e3',
      resolvedContainer: 'self',
      ancestorDistance: 0,
    });
  });

  it('can resolve the nearest scrollable ancestor', () => {
    const parent = createScrollableElement({ scrollTop: 50 });
    const child = createScrollableElement({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
    child.parentElement = parent;

    expect(scrollElementInPage.call(child, 'down', 200, '@e4', 'nearest')).toMatchObject({
      scrollYBefore: 50,
      scrollYAfter: 250,
      moved: true,
      target: '@e4',
      resolvedContainer: 'nearest-scrollable-ancestor',
      ancestorDistance: 1,
    });
    expect(parent.scrollTop).toBe(250);
  });

  it('rejects elements without a scroll range or scroll overflow', () => {
    const noRange = createScrollableElement({ scrollHeight: 200, clientHeight: 200 });
    const visibleOverflow = createScrollableElement({ overflowY: 'visible' });

    expect(scrollElementInPage.call(noRange, 'down', 100, '.static')).toEqual({
      error: 'Element is not scrollable: .static',
    });
    expect(scrollElementInPage.call(visibleOverflow, 'down', 100, '.overflowing')).toEqual({
      error: 'Element is not scrollable: .overflowing',
    });
  });

  it('allows a short root scroller to report the page boundary', () => {
    const root = createScrollableElement({
      scrollTop: 0,
      scrollHeight: 600,
      clientHeight: 600,
      overflowY: 'visible',
    });
    root.ownerDocument.scrollingElement = root;

    expect(scrollElementInPage.call(root, 'down', 600, 'page')).toEqual({
      scrollY: 0,
      scrollHeight: 600,
      clientHeight: 600,
      maxScrollY: 0,
      scrollYBefore: 0,
      scrollYAfter: 0,
      moved: false,
      atTop: true,
      atBottom: true,
      target: 'page',
      resolvedContainer: 'self',
      ancestorDistance: 0,
    });
  });

  it('uses a scrollable body when the document root has no scroll range', () => {
    const root = createScrollableElement({
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 800,
      overflowY: 'auto',
    });
    const body = createScrollableElement({
      scrollTop: 40,
      scrollHeight: 1200,
      clientHeight: 800,
      overflowY: 'auto',
    });
    const document = root.ownerDocument;
    document.nodeType = 9;
    document.scrollingElement = root;
    document.body = body;
    document.documentElement = root;
    document.elementFromPoint = () => body;
    root.ownerDocument = document;
    body.ownerDocument = document;

    expect(scrollElementInPage.call(document, 'down', 200, 'page')).toEqual({
      scrollY: 240,
      scrollHeight: 1200,
      clientHeight: 800,
      maxScrollY: 400,
      scrollYBefore: 40,
      scrollYAfter: 240,
      moved: true,
      atTop: false,
      atBottom: false,
      target: 'page',
      resolvedContainer: 'document-body',
      ancestorDistance: 0,
      containerSelector: 'body',
    });
    expect(body.scrollTop).toBe(240);
  });

  it('uses the nearest active descendant when html and body are not scrollable', () => {
    const root = createScrollableElement({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 });
    const body = createScrollableElement({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 });
    const main = createScrollableElement({
      scrollTop: 10,
      scrollHeight: 1600,
      clientHeight: 600,
      overflowY: 'auto',
    });
    main.id = 'main-scroll';
    main.tagName = 'MAIN';
    main.parentElement = body;
    body.tagName = 'BODY';
    body.parentElement = root;
    body.children = [main];
    root.tagName = 'HTML';
    root.children = [body];

    const document = root.ownerDocument;
    document.nodeType = 9;
    document.scrollingElement = root;
    document.documentElement = root;
    document.body = body;
    document.elementFromPoint = () => main;
    document.querySelectorAll = (selector: string) =>
      selector === '#main-scroll' ? [main] : [root, body, main];
    root.ownerDocument = document;
    body.ownerDocument = document;
    main.ownerDocument = document;

    expect(scrollElementInPage.call(document, 'down', 250, 'page')).toMatchObject({
      scrollYBefore: 10,
      scrollYAfter: 260,
      moved: true,
      resolvedContainer: 'document-descendant',
      ancestorDistance: 1,
      containerSelector: '#main-scroll',
    });
    expect(main.scrollTop).toBe(260);
  });

  it('prefers an active inner scroller even when the page body can scroll', () => {
    const root = createScrollableElement({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 });
    const body = createScrollableElement({ scrollTop: 0, scrollHeight: 1080, clientHeight: 800 });
    const content = createScrollableElement({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 });
    const list = createScrollableElement({
      scrollTop: 0,
      scrollHeight: 8246,
      clientHeight: 253,
      overflowY: 'scroll',
    });
    root.tagName = 'HTML';
    body.tagName = 'BODY';
    content.tagName = 'MAIN';
    list.tagName = 'DIV';
    list.id = 'city-list';
    body.parentElement = root;
    content.parentElement = body;
    list.parentElement = body;
    root.children = [body];
    body.children = [content, list];

    const document = root.ownerDocument;
    document.nodeType = 9;
    document.scrollingElement = root;
    document.documentElement = root;
    document.body = body;
    document.defaultView.innerWidth = 375;
    document.defaultView.innerHeight = 800;
    document.elementFromPoint = (_x: number, y: number) => (y >= 500 ? list : content);
    document.querySelectorAll = (selector: string) =>
      selector === '#city-list' ? [list] : [root, body, content, list];
    for (const candidate of [root, body, content, list]) {
      candidate.ownerDocument = document;
    }

    expect(scrollElementInPage.call(document, 'down', 500, 'page')).toMatchObject({
      scrollYBefore: 0,
      scrollYAfter: 500,
      maxScrollY: 7993,
      resolvedContainer: 'document-descendant',
      containerSelector: '#city-list',
    });
    expect(list.scrollTop).toBe(500);
    expect(body.scrollTop).toBe(0);
  });

  it('falls back to the highest-level visible scroll container', () => {
    const root = createScrollableElement({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 });
    const body = createScrollableElement({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 });
    const main = createScrollableElement({ scrollTop: 0, scrollHeight: 1400, clientHeight: 600 });
    const nested = createScrollableElement({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    const staticChild = createScrollableElement({
      scrollTop: 0,
      scrollHeight: 20,
      clientHeight: 20,
    });
    root.tagName = 'HTML';
    body.tagName = 'BODY';
    main.tagName = 'MAIN';
    main.id = 'page-main';
    nested.tagName = 'DIV';
    nested.id = 'nested-list';
    staticChild.tagName = 'SPAN';
    body.parentElement = root;
    main.parentElement = body;
    nested.parentElement = main;
    staticChild.parentElement = body;
    root.children = [body];
    body.children = [main, staticChild];
    main.children = [nested];
    for (const candidate of [main, nested]) {
      candidate.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 400,
        bottom: 600,
        width: 400,
        height: 600,
      });
    }

    const document = root.ownerDocument;
    document.nodeType = 9;
    document.scrollingElement = root;
    document.documentElement = root;
    document.body = body;
    document.defaultView.innerWidth = 400;
    document.defaultView.innerHeight = 800;
    document.elementFromPoint = () => staticChild;
    document.querySelectorAll = (selector: string) => {
      if (selector === '#page-main') return [main];
      if (selector === '#nested-list') return [nested];
      return [root, body, main, nested, staticChild];
    };
    for (const candidate of [root, body, main, nested, staticChild]) {
      candidate.ownerDocument = document;
    }

    expect(scrollElementInPage.call(document, 'down', 300, 'page')).toMatchObject({
      scrollYAfter: 300,
      resolvedContainer: 'document-descendant',
      containerSelector: '#page-main',
    });
    expect(main.scrollTop).toBe(300);
    expect(nested.scrollTop).toBe(0);
  });
});
