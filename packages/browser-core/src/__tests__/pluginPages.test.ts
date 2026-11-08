import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPluginPageMatchPattern, matchesPluginPageURL } from '../pluginPages';
import { installPluginPageRuntime } from '../pluginPageRuntime';
function event() {
  const listeners: Array<(data?: any) => void> = [];
  return {
    addListener: (fn: any) => listeners.push(fn),
    fire: (data?: any) => listeners.forEach(fn => fn(data)),
  };
}
afterEach(async () => {
  for (const instance of (globalThis as any).__mearlPluginPageInstances?.values() ?? [])
    await instance.dispose();
  delete (globalThis as any).__mearlPluginPageInstances;
  delete (globalThis as any).__mearlPluginPageInstall;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('plugin page URL scope', () => {
  it('matches local previews by file and limits wildcard matches to a single directory', () => {
    const file = 'file:///home/user/plugin-previews/example/test.html';
    const pattern = 'file:///home/user/plugin-previews/example/*.html';
    expect(matchesPluginPageURL([file], file + '?mode=preview#page')).toBe(true);
    expect(matchesPluginPageURL([pattern], file)).toBe(true);
    expect(matchesPluginPageURL([pattern], file.replace('/test.html', '/nested/test.html'))).toBe(false);
    expect(matchesPluginPageURL([pattern], file.replace('file:///', 'file://server/'))).toBe(false);
    expect(isPluginPageMatchPattern('file:///*')).toBe(false);
  });
  it('matches domains, paths, queries and explicit ports without treating punctuation as regex', () => {
    expect(
      matchesPluginPageURL(['https://*.example.test/a?*'], 'https://sub.example.test/a?x=1#part'),
    ).toBe(true);
    expect(matchesPluginPageURL(['https://*.example.test/*'], 'https://example.test/a')).toBe(true);
    expect(
      matchesPluginPageURL(['https://*.example.test/*'], 'https://example.test.attacker.test/a'),
    ).toBe(false);
    expect(matchesPluginPageURL(['http://localhost:8080/*'], 'http://localhost:8081/a')).toBe(
      false,
    );
    expect(matchesPluginPageURL(['https://example.test/a'], 'https://example.test/ab')).toBe(false);
    expect(matchesPluginPageURL(['https://example.test/a'], 'https://example.test/a?q=1')).toBe(
      false,
    );
    expect(matchesPluginPageURL(['*://*/*'], 'file:///tmp/a')).toBe(false);
    expect(matchesPluginPageURL(['*://*/*'], 'invalid')).toBe(false);
    expect(isPluginPageMatchPattern('https://example.test/*#fragment')).toBe(false);
  });
});

describe('document runtime transport', () => {
  it('finishes disposing the prior document owner before constructing its replacement', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        connect: () => ({ onMessage: event(), onDisconnect: event(), disconnect: vi.fn() }),
      },
    });
    let release!: () => void;
    let oldHost: any;
    const disposed = new Promise<void>(resolve => {
      release = resolve;
    });
    await installPluginPageRuntime(
      { instanceId: 'old', identity: { target: {} }, events: {} },
      host => {
        oldHost = host;
        return { dispose: () => disposed };
      },
    );
    const factory = vi.fn(() => ({}));
    const replacing = installPluginPageRuntime(
      { instanceId: 'new', identity: { target: {} }, events: {} },
      factory,
    );
    await vi.waitFor(() => expect(oldHost.signal.aborted).toBe(true));
    const thirdFactory = vi.fn(() => ({}));
    const third = installPluginPageRuntime(
      { instanceId: 'third', identity: { target: {} }, events: {} },
      thirdFactory,
    );
    expect(factory).not.toHaveBeenCalled();
    expect(thirdFactory).not.toHaveBeenCalled();
    release();
    await replacing;
    await third;
    expect(factory).toHaveBeenCalledOnce();
    expect(thirdFactory).toHaveBeenCalledOnce();
    expect([...(globalThis as any).__mearlPluginPageInstances.keys()]).toEqual(['third']);
  });
  it('resends unacknowledged events with a new connection epoch and disposes handlers', async () => {
    vi.useFakeTimers();
    const ports: any[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        connect: () => {
          const onDisconnect = event();
          const port = {
            onMessage: event(),
            onDisconnect,
            postMessage: vi.fn(),
            disconnect: () => onDisconnect.fire(),
          };
          ports.push(port);
          return port;
        },
      },
    });
    let host: any;
    const dispose = vi.fn();
    await installPluginPageRuntime(
      {
        instanceId: 'test',
        token: 'token',
        identity: { target: { documentId: 'one' } },
        events: { state: {} },
        input: {},
      },
      value => {
        host = value;
        return { receive: (message: unknown) => message, dispose };
      },
    );
    const pending = host.emit('state', { value: 1 });
    expect(ports[0].postMessage).not.toHaveBeenCalled();
    ports[0].onMessage.fire({ type: 'ready', epoch: 'first' });
    expect(ports[0].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 1, epoch: 'first' }),
    );
    ports[0].disconnect();
    await vi.advanceTimersByTimeAsync(250);
    ports[1].onMessage.fire({ type: 'ready', epoch: 'second' });
    expect(ports[1].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 1, epoch: 'second' }),
    );
    ports[0].onMessage.fire({ type: 'accepted', sequence: 1 });
    ports[1].onMessage.fire({ type: 'accepted', sequence: 1 });
    await pending;
    await expect(host.emit('undeclared', {})).rejects.toThrow('Undeclared');
    const instance = (globalThis as any).__mearlPluginPageInstances.get('test');
    expect(await instance.send({ value: 2 })).toEqual({ value: 2 });
    await instance.dispose();
    expect(host.signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('propagates per-message cancellation without disposing the page instance', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        connect: () => ({ onMessage: event(), onDisconnect: event(), disconnect: vi.fn() }),
      },
    });
    let received!: AbortSignal;
    await installPluginPageRuntime(
      { instanceId: 'test', token: 'token', identity: { target: {} }, events: {} },
      () => ({
        receive: async (message: any, request: any) => {
          received = request.signal;
          if (message.wait)
            await new Promise<void>(resolve =>
              request.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          request.signal.throwIfAborted();
          return message;
        },
      }),
    );
    const instance = (globalThis as any).__mearlPluginPageInstances.get('test');
    const pending = instance.send({ wait: true }, 'request-one');
    const rejected = expect(pending).rejects.toBeDefined();
    instance.cancel('request-one');
    await rejected;
    expect(received.aborted).toBe(true);
    expect(await instance.send({ value: 2 }, 'request-two')).toEqual({ value: 2 });
    instance.cancel('request-three');
    await expect(instance.send({}, 'request-three')).rejects.toBeDefined();
    const navigation = instance.send({ wait: true });
    const cancelledNavigation = expect(navigation).rejects.toBeDefined();
    await instance.dispose();
    await cancelledNavigation;
    expect(received.aborted).toBe(true);
  });

  it('expires repeated connections that never complete a handshake', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      runtime: {
        connect: () => {
          const onDisconnect = event();
          const port = {
            onMessage: event(),
            onDisconnect,
            postMessage: vi.fn(),
            disconnect: () => onDisconnect.fire(),
          };
          setTimeout(() => onDisconnect.fire(), 1);
          return port;
        },
      },
    });
    const dispose = vi.fn();
    await installPluginPageRuntime(
      { instanceId: 'test', token: 'token', identity: { target: {} }, events: {} },
      () => ({ dispose }),
    );
    await vi.advanceTimersByTimeAsync(31000);
    expect(dispose).toHaveBeenCalledOnce();
    expect((globalThis as any).__mearlPluginPageInstances.size).toBe(0);
  });
});
