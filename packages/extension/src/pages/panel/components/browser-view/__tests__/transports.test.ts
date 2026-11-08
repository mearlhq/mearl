import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserViewTransports } from '../transports';

const id = '12345678-1234-1234-1234-123456789abc';
const definition = { events: { kind: 'eventSource' as const, setting: 'exampleEnabled' } };
let channels: any[];
beforeEach(() => {
  channels = [];
  chrome.runtime.getURL = () => 'about:blank';
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), onmessage: null };
      port2 = { close: vi.fn() };
      constructor() {
        channels.push(this);
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('projects opaque input to the transport authorization operation and removes its private frame on close', async () => {
  const authorize = vi.fn(async () => ({
    url: 'https://example.com/events',
    kind: 'eventSource' as const,
    policies: ['connect-src https:', 'connect-src https:'],
  }));
  const emit = vi.fn(),
    transports = createBrowserViewTransports(authorize, emit, definition);
  await transports.open({
    id,
    name: 'events',
    url: 'https://example.com/events',
    operation: 'preferences',
    policies: [],
  } as any);
  expect(authorize).toHaveBeenCalledExactlyOnceWith({
    name: 'events',
    url: 'https://example.com/events',
  });
  expect(document.querySelectorAll('iframe')).toHaveLength(1);
  const frame = document.querySelector('iframe')!;
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      data: { type: 'transport-ready', context: new URL(frame.src).searchParams.get('context') },
    }),
  );
  expect(channels[0].port1.onmessage).toBeTypeOf('function');
  transports.close(id);
  expect(frame.isConnected).toBe(false);
  expect(channels[0].port1.close).toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  transports.dispose();
});
it('cancels late authorization and refuses duplicate or undeclared connection identities', async () => {
  let finish!: (value: any) => void;
  const authorize = vi.fn(
    () =>
      new Promise<any>(resolve => {
        finish = resolve;
      }),
  );
  const transports = createBrowserViewTransports(authorize, vi.fn(), definition);
  const opening = transports.open({ id, name: 'events', url: 'https://example.com/events' });
  await expect(
    transports.open({ id, name: 'events', url: 'https://example.com/events' }),
  ).rejects.toThrow();
  await expect(
    transports.open({ id: 'bad', name: 'unknown', url: 'https://example.com/events' }),
  ).rejects.toThrow();
  transports.close(id);
  finish({ url: 'https://example.com/events', kind: 'eventSource', policies: [] });
  await expect(opening).rejects.toThrow('closed while preparing');
  expect(document.querySelector('iframe')).toBeNull();
  transports.dispose();
});
it('emits a terminal event on revocation, closes native frames and ignores late messages', async () => {
  const emit = vi.fn(),
    transports = createBrowserViewTransports(
      async () => ({
        url: 'https://example.com/events',
        kind: 'eventSource',
        policies: ['connect-src https:', 'connect-src https:'],
      }),
      emit,
      definition,
    );
  await transports.open({ id, name: 'events', url: 'https://example.com/events' });
  const receive = channels[0].port1.onmessage;
  receive({ data: { type: 'message', readyState: 1, data: 'before' } });
  transports.invalidate();
  receive({ data: { type: 'message', readyState: 1, data: 'late' } });
  expect(emit.mock.calls.map(([value]) => value.type)).toEqual(['message', 'error']);
  expect(emit).toHaveBeenLastCalledWith({ id, type: 'error', readyState: 2 });
  expect(document.querySelector('iframe')).toBeNull();
  transports.dispose();
});

it('does not let stale authorization close a new generation reusing the same id', async () => {
  let finish!: (value: any) => void;
  const policy = {
    url: 'https://example.com/events',
    kind: 'eventSource' as const,
    policies: ['connect-src https:', 'connect-src https:'],
  };
  const authorize = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(policy);
  const transports = createBrowserViewTransports(authorize, vi.fn(), definition);
  const old = transports.open({ id, name: 'events', url: policy.url });
  transports.close(id);
  await transports.open({ id, name: 'events', url: policy.url });
  const frame = document.querySelector('iframe')!;
  finish(policy);
  await expect(old).rejects.toThrow('closed while preparing');
  expect(frame.isConnected).toBe(true);
  expect(channels[1].port1.close).not.toHaveBeenCalled();
  transports.dispose();
});
