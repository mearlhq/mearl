import { afterEach, describe, expect, it, vi } from 'vitest';
import { executePageWebMcp, PageWebMcpObservation, type PageWebMcpResult } from '../pageWebMcp.js';

const url = 'https://example.test/orders';

afterEach(() => vi.unstubAllGlobals());

describe('page WebMCP', () => {
  it('keeps the native tool object and refuses to look up an expired ref by name', async () => {
    const window = {};
    class Tool {
      name = 'get_order';
      description = 'Get an order';
      origin = 'https://example.test';
      window = window;
    }
    const tool = new Tool();
    const executeTool = vi.fn(async (target, input) => ({ target, input }));
    vi.stubGlobal('Tool', Tool);
    vi.stubGlobal('window', window);
    vi.stubGlobal('location', { href: url });
    vi.stubGlobal('document', { modelContext: { getTools: async () => [tool], executeTool } });

    const discovered = await executePageWebMcp({ operation: 'discover' });
    expect(discovered).toHaveProperty('catalog.status', 'ready');
    if (!('catalog' in discovered)) throw new Error('Expected a catalog');
    const toolRef = discovered.catalog.tools[0]!.ref!;
    await executePageWebMcp({ operation: 'call', toolRef, input: { id: 7 } });
    expect(executeTool.mock.calls[0]?.[0]).toBe(tool);
    expect(
      await executePageWebMcp({ operation: 'call', toolRef: 'missing', input: {} }),
    ).toHaveProperty('error', expect.stringContaining('WEBMCP_STALE_TOOL'));
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('returns legacy metadata without a callable ref', async () => {
    const window = {};
    vi.stubGlobal('Tool', undefined);
    vi.stubGlobal('window', window);
    vi.stubGlobal('location', { href: url });
    vi.stubGlobal('document', {
      modelContext: {
        getTools: async () => [
          { name: 'get_order', description: 'Get an order', origin: url, window },
        ],
        executeTool: vi.fn(),
      },
    });

    const result = await executePageWebMcp({ operation: 'discover' });
    expect(result).toHaveProperty('catalog.status', 'discovery-only');
    expect(result).toHaveProperty('catalog.tools.0.name', 'get_order');
    expect(result).not.toHaveProperty('catalog.tools.0.ref');
  });

  it('ignores a late observation after navigation and omits empty default output', async () => {
    const observation = new PageWebMcpObservation();
    const tool = { ref: 'old', name: 'get_order', description: 'Get an order', origin: url };
    let finish!: (result: PageWebMcpResult) => void;
    const probe = new Promise<PageWebMcpResult>(resolve => {
      finish = resolve;
    });
    const pending = observation.refresh(() => probe);
    expect(observation.fields(url)).toEqual({});
    observation.reset();
    finish({ catalog: { url, status: 'ready', tools: [tool], truncated: false } });
    await pending;
    expect(observation.fields(url)).toEqual({});
    expect(() => observation.assertRef('old')).toThrow('WEBMCP_STALE_TOOL');

    await observation.refresh(async () => ({
      catalog: { url, status: 'ready', tools: [], truncated: false },
    }));
    expect(observation.fields(url)).toEqual({});
    expect(observation.fields(url, true)).toEqual({ webmcp: [], webmcpStatus: 'ready' });
  });
});
