import { describe, expect, it, vi } from 'vitest';
import type { PageSession } from '../cdp-session.js';
import { watchCdpWebMcp } from '../webmcp-handlers.js';

const url = 'https://example.test/orders';
const tool = { name: 'get_order', description: 'Read an order', origin: 'https://example.test' };

function fixture(eventsSupported = true) {
  const handlers = new Map<string, (data: any) => void>();
  let tools = [tool];
  let failNextEvaluation = false;
  let evaluate = async () => ({
    result: { value: { catalog: { url, status: 'ready', tools, truncated: false } } },
  });
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'WebMCP.enable' && !eventsSupported) throw new Error('Method not found');
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate') {
      if (failNextEvaluation) {
        failNextEvaluation = false;
        throw new Error('Context unavailable');
      }
      return evaluate();
    }
    return {};
  });
  const session = {
    client: {
      sendCommand,
      on(method: string, handler: (data: any) => void) {
        handlers.set(method, handler);
        return () => {
          handlers.delete(method);
        };
      },
    },
  } as unknown as PageSession;
  return {
    session,
    emit: (method: string, data: unknown) => handlers.get(method)?.(data),
    evaluationCount: () =>
      sendCommand.mock.calls.filter(([method]) => method === 'Runtime.evaluate').length,
    removeTools: () => {
      tools = [];
    },
    failNextEvaluation: () => {
      failNextEvaluation = true;
    },
    holdEvaluation: (gate: Promise<void>) => {
      const previous = evaluate;
      evaluate = async () => {
        const result = await previous();
        await gate;
        return result;
      };
    },
  };
}

describe('CDP WebMCP discovery', () => {
  it('refreshes on late registration and removal without probing on each action', async () => {
    const browser = fixture();
    const observation = watchCdpWebMcp(browser.session);
    expect(browser.evaluationCount()).toBe(0);

    browser.emit('WebMCP.toolsAdded', { tools: [{ frameId: 'main' }] });
    await observation.refreshCatalog();
    expect(observation.fields(url)).toEqual({ webmcp: [tool] });
    expect(observation.refreshCatalog()).toBeUndefined();
    expect(browser.evaluationCount()).toBe(1);

    browser.removeTools();
    browser.emit('WebMCP.toolsRemoved', { tools: [{ frameId: 'main' }] });
    await observation.refreshCatalog();
    expect(observation.fields(url)).toEqual({});
    expect(browser.evaluationCount()).toBe(2);
  });

  it('rechecks a catalog change that occurs during an in-flight probe', async () => {
    const browser = fixture();
    const observation = watchCdpWebMcp(browser.session);
    let release!: () => void;
    browser.holdEvaluation(
      new Promise<void>(resolve => {
        release = resolve;
      }),
    );
    browser.emit('WebMCP.toolsAdded', { tools: [{ frameId: 'main' }] });
    await vi.waitFor(() => expect(browser.evaluationCount()).toBe(1), { interval: 1 });

    browser.removeTools();
    browser.emit('WebMCP.toolsRemoved', { tools: [{ frameId: 'main' }] });
    release();
    await observation.refreshCatalog();
    expect(browser.evaluationCount()).toBe(2);
    expect(observation.fields(url, true)).toMatchObject({ webmcp: [], webmcpStatus: 'ready' });
  });

  it('retains passive discovery when the browser does not support CDP WebMCP events', async () => {
    const browser = fixture(false);
    const observation = watchCdpWebMcp(browser.session);
    await observation.refreshCatalog();
    expect(observation.fields(url)).toEqual({ webmcp: [tool] });
    browser.removeTools();
    await observation.refreshCatalog();
    expect(observation.fields(url)).toEqual({});
    expect(browser.evaluationCount()).toBe(2);
  });

  it('keeps probing when enable succeeds but no tool events arrive', async () => {
    const browser = fixture();
    const observation = watchCdpWebMcp(browser.session);
    await Promise.resolve();
    await observation.refreshCatalog();
    expect(observation.fields(url)).toEqual({ webmcp: [tool] });
  });

  it('retries a failed event-triggered probe on the next snapshot', async () => {
    const browser = fixture();
    const observation = watchCdpWebMcp(browser.session);
    browser.failNextEvaluation();
    browser.emit('WebMCP.toolsAdded', { tools: [{ frameId: 'main' }] });
    await observation.refreshCatalog();
    expect(observation.fields(url)).toEqual({});

    await observation.refreshCatalog();
    expect(observation.fields(url)).toEqual({ webmcp: [tool] });
    expect(observation.refreshCatalog()).toBeUndefined();
  });

  it('matches navigation tools against the committed document after a redirect', async () => {
    const browser = fixture();
    const observation = watchCdpWebMcp(browser.session);
    browser.emit('Page.frameNavigated', { frame: { id: 'main', url } });
    await observation.refreshCatalog();
    expect(observation.navigationFields('https://example.test/redirect')).toEqual({
      webmcp: [tool],
    });
  });
});
