import { describe, expect, it, vi } from 'vitest';
import { callPluginPageService, callPluginStateService } from '../plugin-host-services.js';

const clients = vi.hoisted(() => [] as Array<{ options: any }>);
vi.mock('@mearl/client', () => ({
  PluginHostConnection: class {
    constructor(readonly options: any) {
      clients.push(this);
    }
    request(method: string, envelope: any) {
      return method === 'state.call'
        ? Promise.resolve({ exists: false })
        : this.options.invoke('page_runtime', envelope.input, {});
    }
  },
  PluginModelClient: class {},
  PluginStateClient: class {
    constructor(readonly options: any) {}
    call(_plugin: string, _collection: string, _operation: string, input: any) {
      return this.options.connection.request('state.call', { input });
    }
  },
  PluginPageClient: class {
    constructor(
      _options: any,
      readonly connection: any,
    ) {}
    call(_plugin: string, _operation: string, input: any) {
      return this.connection.request('page.call', { input });
    }
  },
}));

describe('plugin page interaction channels', () => {
  it('keeps interactive page requests independent from a previously cached background client', async () => {
    const background = vi.fn().mockResolvedValue('background');
    const interactive = vi.fn().mockResolvedValue('interactive');
    const event = vi.fn().mockResolvedValue('event');
    await callPluginStateService('permission-fixture', {}, () => background);
    await expect(
      callPluginPageService(
        'permission-fixture',
        { operation: 'resolve' },
        () => interactive,
        false,
        true,
      ),
    ).resolves.toBe('interactive');
    await expect(
      callPluginPageService('permission-fixture', { operation: 'get' }, () => background),
    ).resolves.toBe('background');
    await expect(
      callPluginPageService('permission-fixture', { operation: 'get' }, () => event, true),
    ).resolves.toBe('event');
    expect(clients).toHaveLength(3);
    expect(background).toHaveBeenCalledOnce();
    expect(interactive).toHaveBeenCalledOnce();
    expect(event).toHaveBeenCalledOnce();
    expect(clients.map(client => client.options.access)).toEqual(['toolbox', 'toolbox', 'runtime']);
  });
});
