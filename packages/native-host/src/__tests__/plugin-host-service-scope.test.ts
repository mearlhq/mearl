import { describe, expect, it, vi } from 'vitest';

const connections = vi.hoisted(() => [] as any[]);
vi.mock('@mearl/client', () => ({
  PluginHostConnection: class {
    constructor(readonly options: any) {
      connections.push(this);
    }
    request() {
      return this.options.invoke('page_runtime', {});
    }
  },
  PluginPageClient: class {
    constructor(
      _options: any,
      readonly connection: any,
    ) {}
    call() {
      return this.connection.request();
    }
  },
  PluginModelClient: class {},
  PluginStateClient: class {},
}));
import { callPluginPageService } from '../plugin-host-services.js';

describe('plugin page callback routing', () => {
  it('keeps extension and CDP callbacks separate while reusing connections within one scope', async () => {
    const extension = vi.fn(async () => 'extension');
    const cdp = vi.fn(async () => 'cdp');
    expect(await callPluginPageService('fixture', { operation: 'resolve' }, () => extension)).toBe(
      'extension',
    );
    expect(
      await callPluginPageService(
        'fixture',
        { operation: 'resolve' },
        () => cdp,
        false,
        false,
        'cdp',
      ),
    ).toBe('cdp');
    expect(
      await callPluginPageService(
        'fixture',
        { operation: 'resolve' },
        () => cdp,
        false,
        false,
        'cdp',
      ),
    ).toBe('cdp');
    expect(connections).toHaveLength(2);
    expect(connections.map(connection => connection.options.scopeId)).toEqual([
      `${process.pid}:extension`,
      `${process.pid}:cdp`,
    ]);
  });
});
