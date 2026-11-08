import { describe, expect, it, vi } from 'vitest';
import { invokePluginTool } from '../pluginTools.js';

describe('MCP registered plugin invocation', () => {
  it('forwards a structured plugin request and browser routing to the client SDK', async () => {
    const invoke = vi.fn().mockResolvedValue({ items: [] });

    await expect(
      invokePluginTool(
        {
          plugin: 'site-tools',
          command: 'list',
          input: { pageIndex: 2 },
          browser: 'mearl:remote:office:chrome',
          timeoutSec: 30,
        },
        invoke,
      ),
    ).resolves.toEqual({ items: [] });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'site-tools',
      { command: 'list', input: { pageIndex: 2 } },
      { browser: 'mearl:remote:office:chrome', timeoutSec: 30, source: 'mcp' },
    );
  });

  it('defaults command input and rejects malformed envelopes before loading a plugin', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      invokePluginTool({ plugin: 'site-tools', command: 'current' }, invoke),
    ).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith(
      'site-tools',
      { command: 'current', input: {} },
      { source: 'mcp' },
    );

    for (const value of [
      null,
      { plugin: '', command: 'list' },
      { plugin: 'site-tools', command: '' },
      { plugin: 'site-tools', command: 'list', input: [] },
      { plugin: 'site-tools', command: 'list', timeoutSec: 0 },
      { plugin: 'site-tools', command: 'list', timeoutSec: '30' },
    ]) {
      await expect(invokePluginTool(value, invoke)).rejects.toThrow();
    }
    expect(invoke).toHaveBeenCalledOnce();
  });
});
