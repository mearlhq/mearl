import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BROWSER_DEVICE_PRESET_NAMES } from '@mearl/client';

const state = vi.hoisted(() => ({
  handlers: new Map<unknown, (request?: any, extra?: any) => Promise<any>>(),
  executeScript: vi.fn(),
  invoke: vi
    .fn()
    .mockImplementation(async (action: string) =>
      action === 'page_eval' ? { result: 'business' } : { clicked: true },
    ),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler(schema: unknown, handler: (request?: any) => Promise<any>) {
      state.handlers.set(schema, handler);
    }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('@mearl/client', async importOriginal => ({
  ...(await importOriginal<typeof import('@mearl/client')>()),
  invoke: state.invoke,
}));
vi.mock('@mearl/client/script', () => ({ executeScript: state.executeScript }));
vi.mock('fs', async importOriginal => ({
  ...(await importOriginal<typeof import('fs')>()),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

const originalArgv = [...process.argv];

beforeAll(async () => {
  process.argv = originalArgv.slice(0, 2);
  vi.spyOn(process, 'on').mockReturnValue(process);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../index.js');
});

afterAll(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('MCP page tool contracts', () => {
  it('exposes read-only capability discovery with target routing and optional App details', async () => {
    const { tools } = await state.handlers.get(ListToolsRequestSchema)!();
    const tool = tools.find((tool: any) => tool.name === 'browser_get_capabilities');
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.inputSchema.properties.app.type).toBe('string');
    await state.handlers.get(CallToolRequestSchema)!({
      params: {
        name: 'browser_get_capabilities',
        arguments: { app: 'example/app', browser: 'test-browser' },
      },
    });
    expect(state.invoke).toHaveBeenCalledWith(
      'get_capabilities',
      { app: 'example/app' },
      expect.objectContaining({ browser: 'test-browser' }),
    );
  });
  it('bounds the final script response while retaining execution and session metadata', async () => {
    state.executeScript.mockResolvedValueOnce({
      success: true,
      stdout: 'x'.repeat(1024 * 1024),
      stderr: '',
      executionStopped: true,
      mayHaveLateEffects: false,
      pendingActions: [],
      session: { sessionId: 's_existing' },
    });
    const result = await state.handlers.get(CallToolRequestSchema)!({
      params: { name: 'browser_run_code', arguments: { code: 'console.log(data)' } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: { code: 'RESPONSE_TOO_LARGE' },
      success: true,
      executionStopped: true,
      mayHaveLateEffects: false,
      pendingActions: [],
      session: { sessionId: 's_existing' },
    });
    expect(result.content[0].text.length).toBeLessThan(16384);
  });
  it('runs code with SDK routing and propagates MCP cancellation and script failures', async () => {
    const { tools } = await state.handlers.get(ListToolsRequestSchema)!();
    const tool = tools.find((tool: any) => tool.name === 'browser_run_code');
    expect(tool.inputSchema.required).toEqual(['code']);
    const controller = new AbortController();
    const value = {
      success: false,
      stdout: 'partial\n',
      stderr: '',
      error: { code: 'SCRIPT_TIMEOUT' },
      executionStopped: true,
      mayHaveLateEffects: true,
      pendingActions: ['pageClick'],
      session: { sessionId: 's_existing' },
    };
    state.executeScript.mockResolvedValueOnce(value);
    const result = await state.handlers.get(CallToolRequestSchema)!(
      {
        params: {
          name: 'browser_run_code',
          arguments: {
            code: 'await mearl.tabList();',
            browser: 'chosen',
            session: 's_existing',
            timeoutSec: 30,
          },
        },
      },
      { signal: controller.signal },
    );
    expect(state.executeScript).toHaveBeenCalledWith('await mearl.tabList();', {
      browser: 'chosen',
      session: 's_existing',
      executionTimeoutSec: 30,
      source: 'mcp',
      signal: controller.signal,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(value);
  });
  it('keeps screenshot pixels separate from concise session metadata', async () => {
    state.invoke.mockResolvedValueOnce({
      data: 'pixels',
      meta: { format: 'png' },
      session: { sessionId: 's_fixture', status: 'active' },
    });
    const result = await state.handlers.get(CallToolRequestSchema)!({
      params: { name: 'browser_page_screenshot', arguments: { tabId: 7 } },
    });
    expect(result.content[0]).toEqual({ type: 'image', data: 'pixels', mimeType: 'image/png' });
    expect(JSON.parse(result.content[1].text)).toEqual({
      meta: { format: 'png' },
      session: { sessionId: 's_fixture', status: 'active' },
    });
  });
  it('offers business plugin invocation without exposing host service tools', async () => {
    const { tools } = await state.handlers.get(ListToolsRequestSchema)!();
    expect(
      tools.filter((tool: any) => tool.name.startsWith('plugin_')).map((tool: any) => tool.name),
    ).toEqual(['plugin_invoke']);
    for (const name of ['plugin_task', 'plugin_state', 'plugin_page', 'plugin_model']) {
      const result = await state.handlers.get(CallToolRequestSchema)!({
        params: { name, arguments: { operation: 'list' } },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    }
  });
  it('retains the session handle and execution state when a result exceeds the response limit', async () => {
    state.invoke.mockResolvedValueOnce({
      snapshot: 'x'.repeat(1024 * 1024 + 1),
      session: {
        sessionId: 'session-id',
        browserId: 'browser-id',
        transport: 'cdp',
        status: 'active',
        generation: 1,
      },
      failedStep: 1,
      completedSteps: 1,
      totalSteps: 2,
      stage: 'dispatch-uncertain',
    });
    const result = await state.handlers.get(CallToolRequestSchema)!({
      params: { name: 'browser_page_snapshot', arguments: { tabId: 1, session: 'new' } },
    });
    const diagnostic = JSON.parse(result.content[0].text);
    expect(diagnostic).toMatchObject({
      error: { code: 'RESPONSE_TOO_LARGE' },
      session: { sessionId: 'session-id', status: 'active' },
      failedStep: 1,
      completedSteps: 1,
      stage: 'dispatch-uncertain',
    });
    expect(diagnostic).not.toHaveProperty('snapshot');
    expect(result.isError).toBe(true);
  });

  it('uses the same dispatch for scoped and ordinary tools', async () => {
    const args = { tabId: 1, selector: '#button', session: 'session-id' };
    await state.handlers.get(CallToolRequestSchema)!({
      params: { name: 'browser_page_click', arguments: args },
    });
    expect(state.invoke).toHaveBeenLastCalledWith(
      'page_click',
      { tabId: 1, selector: '#button' },
      { session: 'session-id' },
    );
  });

  it('returns batch screenshots as images while preserving failure and session metadata', async () => {
    state.invoke.mockResolvedValueOnce({
      session: { sessionId: 'session-id' },
      completedSteps: 1,
      failedStep: 1,
      results: [
        {
          step: 0,
          action: 'page_screenshot',
          success: true,
          data: { data: 'pixels', meta: { format: 'png' } },
        },
        { step: 1, action: 'page_click', success: false, error: 'paused' },
      ],
    });
    const result = await state.handlers.get(CallToolRequestSchema)!({
      params: {
        name: 'browser_run_actions',
        arguments: { tabId: 1, actions: [], session: 'session-id' },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'image', data: 'pixels', mimeType: 'image/png' });
    const metadata = JSON.parse(result.content[1].text);
    expect(metadata).toMatchObject({
      failedStep: 1,
      session: { sessionId: 'session-id' },
      results: [{ data: { meta: { format: 'png' } } }, { success: false }],
    });
    expect(metadata.results[0].data).not.toHaveProperty('data');
  });

  it('exposes the supported frame and diagnostic fields without enabling eval observation by default', async () => {
    const { tools } = await state.handlers.get(ListToolsRequestSchema)!();
    const click = tools.find((tool: any) => tool.name === 'browser_page_click');
    const evaluate = tools.find((tool: any) => tool.name === 'browser_page_eval');
    expect(click.inputSchema.properties.frameId.type).toBe('string');
    expect(click.inputSchema.properties.coordinateSpace.enum).toEqual([
      'outer-viewport',
      'active-frame',
    ]);
    expect(evaluate.inputSchema.properties.observe).not.toHaveProperty('default');
    expect(
      evaluate.inputSchema.properties.diagnostics.properties.requests.properties,
    ).toMatchObject({
      maxBodySize: { type: 'number' },
      fields: { type: 'array', maxItems: 100 },
      keysOnly: { type: 'boolean' },
    });
    const emulation = tools.find((tool: any) => tool.name === 'browser_set_device_emulation');
    expect(emulation.inputSchema.properties.preset.enum).toEqual([...BROWSER_DEVICE_PRESET_NAMES]);
  });

  it('forwards frame-relative click coordinates and diagnostic selection to the SDK', async () => {
    const args = {
      tabId: 1,
      frameId: 'business',
      coordinateSpace: 'active-frame',
      point: { x: 30, y: 40 },
      diagnostics: { requests: { fields: ['data.id'], keysOnly: true, maxBodySize: 256 } },
    };
    await state.handlers.get(CallToolRequestSchema)!({
      params: { name: 'browser_page_click', arguments: args },
    });
    expect(state.invoke).toHaveBeenCalledWith('page_click', args, {});
  });

  it('forwards eval frame selection while leaving observation omitted', async () => {
    const args = { tabId: 1, frameId: 'business', expression: 'window.appState' };
    const result = await state.handlers.get(CallToolRequestSchema)!({
      params: { name: 'browser_page_eval', arguments: args },
    });
    expect(state.invoke).toHaveBeenCalledWith('page_eval', args, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ result: 'business' });
  });
});

it.each(['sample-session', { presets: ['sample-session'], domains: ['site.example.com'] }])(
  'forwards capability-provided Cookie scopes through the existing browser_manage tool',
  async scope => {
    const args = { operation: 'launch', name: 'fixture', copyCookieDomains: scope };
    const result = await state.handlers.get(CallToolRequestSchema)!({
      params: { name: 'browser_manage', arguments: args },
    });
    expect(state.invoke).toHaveBeenLastCalledWith('browser_manage', args, {});
    expect(result.isError).toBeUndefined();
  },
);
