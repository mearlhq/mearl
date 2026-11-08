import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserView } from '../BrowserView';
import { showToast } from '../../../utils/toast';
import type { SelectedBrowserView } from '@mearl/preset/bundles';
vi.mock('../../../utils/i18n', () => ({
  t: (key: string) => key,
  getCurrentLanguage: () => 'zh_CN',
}));
vi.mock('../../../utils/toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../../../shared/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../LoginModal', () => ({
  LoginModal: ({ onClose }: { onClose(): void }) => (
    <button onClick={onClose}>hostLoginClose</button>
  ),
}));
type Port = {
  onmessage: ((event: { data: any }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  start(): void;
  close(): void;
};
let channels: Array<{ port1: Port; port2: Port }>;
let ready: () => void;
const selected: SelectedBrowserView = {
  bundleId: 'example',
  revision: 'accepted',
  slot: 'requestImport',
  html: '<main/>',
  definition: {
    schemaVersion: 1,
    entry: 'view.html',
    actions: {},
    logins: { example: { url: 'https://example.com/login', title: { en: 'Login' } } },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  channels = [];
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1: Port = { onmessage: null, postMessage: vi.fn(), start() {}, close() {} };
      port2: Port = { onmessage: null, postMessage: vi.fn(), start() {}, close() {} };
      constructor() {
        channels.push(this);
      }
    },
  );
  chrome.runtime.getURL = () => 'about:blank';
  chrome.runtime.connect = vi.fn(() => {
    let disconnected!: () => void;
    return {
      onMessage: {
        addListener: (fn: (message: unknown) => void) => {
          ready = () => fn({ ready: true });
        },
      },
      onDisconnect: {
        addListener: (fn: () => void) => {
          disconnected = fn;
        },
      },
      disconnect: () => disconnected(),
    } as any;
  });
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => ({
    success: true,
    data: {},
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function receive(value: unknown, index = 0) {
  await act(async () => {
    channels[index].port1.onmessage?.({ data: value });
    await Promise.resolve();
  });
}
it('opens ordinary and modified external links through the host and rejects executable or credentialed URLs', async () => {
  chrome.tabs = { create: vi.fn(async () => ({})) } as any;
  render(
    <BrowserView
      selected={selected}
      isOpen
      context={{ isOpen: true }}
      onAccepted={vi.fn()}
      onRefresh={vi.fn(async () => {})}
      onCall={vi.fn(async () => {})}
    />,
  );
  await receive({
    type: 'view-call',
    id: 1,
    method: 'openUrl',
    input: { url: 'https://example.com/cases' },
  });
  expect(chrome.tabs.create).toHaveBeenCalledWith({
    url: 'https://example.com/cases',
    active: true,
  });
  await receive({
    type: 'view-call',
    id: 2,
    method: 'openUrl',
    input: { url: 'https://example.com/cases', background: true },
  });
  expect(chrome.tabs.create).toHaveBeenCalledWith({
    url: 'https://example.com/cases',
    active: false,
  });
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.com', 'file:///tmp/cases'])
    await receive({ type: 'view-call', id: 3, method: 'openUrl', input: { url } });
  expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
});
it('keeps host close and retry usable when a view never becomes ready', async () => {
  vi.useFakeTimers();
  const onCall = vi.fn(async () => {}),
    onRefresh = vi.fn(async () => {});
  render(
    <BrowserView
      selected={selected}
      isOpen
      context={{ isOpen: true }}
      onAccepted={vi.fn()}
      onRefresh={onRefresh}
      onCall={onCall}
    />,
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCall).toHaveBeenCalledWith('close', {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('browserViewUnavailable');
  fireEvent.click(screen.getByText('close'));
  expect(onCall).toHaveBeenCalledTimes(2);
  await act(async () => {
    fireEvent.click(screen.getByText('retry'));
    await Promise.resolve();
  });
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(channels).toHaveLength(2);
});
it('accepts before initialization, clears the startup deadline on mounting and keeps one accepted instance when retrying', async () => {
  const onAccepted = vi.fn();
  render(
    <BrowserView
      selected={selected}
      isOpen
      context={{ isOpen: true }}
      onAccepted={onAccepted}
      onRefresh={vi.fn(async () => {})}
      onCall={vi.fn(async () => {})}
    />,
  );
  await receive({ type: 'view-ready' });
  expect(onAccepted).toHaveBeenCalledWith(selected);
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'view-init' }),
  );
  await receive({ type: 'view-call', id: 1, method: 'mounted' });
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16000);
  });
  expect(screen.queryByRole('alert')).toBeNull();
});
it('cancels pending login preparation when the private view hides it and never shows a late host modal', async () => {
  render(
    <BrowserView
      selected={selected}
      isOpen
      context={{ isOpen: true }}
      onAccepted={vi.fn()}
      onRefresh={vi.fn(async () => {})}
      onCall={vi.fn(async () => {})}
    />,
  );
  await receive({ type: 'view-ready' });
  await receive({ type: 'view-call', id: 2, method: 'login.show', input: { name: 'example' } });
  expect(chrome.runtime.connect).toHaveBeenCalledOnce();
  await receive({ type: 'view-call', id: 3, method: 'login.hide', input: { name: 'example' } });
  await act(async () => {
    ready();
  });
  expect(screen.queryByText('hostLoginClose')).toBeNull();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ operation: 'loginOpen' }) }),
  );
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ operation: 'loginClose' }) }),
  );
});
it('releases a visible login immediately when the user closes it', async () => {
  render(
    <BrowserView
      selected={selected}
      isOpen
      context={{ isOpen: true }}
      onAccepted={vi.fn()}
      onRefresh={vi.fn(async () => {})}
      onCall={vi.fn(async () => {})}
    />,
  );
  await receive({ type: 'view-ready' });
  await receive({ type: 'view-call', id: 2, method: 'login.show', input: { name: 'example' } });
  await act(async () => {
    ready();
  });
  fireEvent.click(await screen.findByText('hostLoginClose'));
  await waitFor(() =>
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ operation: 'loginClose' }) }),
    ),
  );
  expect(screen.queryByText('hostLoginClose')).toBeNull();
});

it('cannot override transport authorization and releases connections when the view closes', async () => {
  const metadata = {
    ...selected,
    definition: {
      ...selected.definition,
      transports: { events: { kind: 'eventSource' as const, setting: 'exampleEnabled' } },
    },
  };
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => ({
    success: true,
    data: {
      url: 'https://example.com/events',
      kind: 'eventSource',
      policies: ['connect-src https:', 'connect-src https:'],
    },
  }));
  const props = {
    selected: metadata,
    context: { isOpen: true },
    onAccepted: vi.fn(),
    onRefresh: vi.fn(),
    onCall: vi.fn(),
  };
  const view = render(<BrowserView {...props} isOpen />);
  await receive({
    type: 'view-call',
    id: 50,
    method: 'transport.open',
    input: {
      id: '12345678-1234-1234-1234-123456789abc',
      name: 'events',
      url: 'https://example.com/events',
      operation: 'preferences',
      instanceId: 'other',
      revision: 'other',
    },
  });
  expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        operation: 'transport',
        name: 'events',
        url: 'https://example.com/events',
        revision: 'accepted',
        bundleId: 'example',
      }),
    }),
  );
  expect(document.querySelectorAll('iframe')).toHaveLength(2);
  view.rerender(<BrowserView {...props} context={{ isOpen: false }} isOpen={false} />);
  expect(document.querySelectorAll('iframe')).toHaveLength(1);
  const calls = vi.mocked(chrome.runtime.sendMessage).mock.calls.length;
  await receive({
    type: 'view-call',
    id: 51,
    method: 'transport.open',
    input: {
      id: '22345678-1234-1234-1234-123456789abc',
      name: 'events',
      url: 'https://example.com/events',
    },
  });
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(calls);
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'view-result', id: 51, success: false }),
  );
});
it('does not append a native transport after the view closes during authorization', async () => {
  let finish!: (value: any) => void;
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const metadata = {
    ...selected,
    definition: {
      ...selected.definition,
      transports: { events: { kind: 'eventSource' as const, setting: 'exampleEnabled' } },
    },
  };
  const props = {
    selected: metadata,
    context: { isOpen: true },
    onAccepted: vi.fn(),
    onRefresh: vi.fn(),
    onCall: vi.fn(),
  };
  const view = render(<BrowserView {...props} isOpen />);
  await receive({
    type: 'view-call',
    id: 60,
    method: 'transport.open',
    input: {
      id: '12345678-1234-1234-1234-123456789abc',
      name: 'events',
      url: 'https://example.com/events',
    },
  });
  view.rerender(<BrowserView {...props} context={{ isOpen: false }} isOpen={false} />);
  await act(async () => {
    finish({
      success: true,
      data: { url: 'https://example.com/events', kind: 'eventSource', policies: [] },
    });
  });
  expect(document.querySelectorAll('iframe')).toHaveLength(1);
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'view-result', id: 60, success: false }),
  );
});

it('releases native transports on Chrome permission removal and unregisters the listener on unmount', async () => {
  const addListener = vi.fn(),
    removeListener = vi.fn();
  const permissions = chrome.permissions;
  chrome.permissions = { ...permissions, onRemoved: { addListener, removeListener } } as any;
  try {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      success: true,
      data: {
        url: 'https://example.com/events',
        kind: 'eventSource',
        policies: ['connect-src https:', 'connect-src https:'],
      },
    });
    const metadata = {
      ...selected,
      definition: {
        ...selected.definition,
        transports: { events: { kind: 'eventSource' as const, setting: 'exampleEnabled' } },
      },
    };
    const view = render(
      <BrowserView
        selected={metadata}
        isOpen
        context={{ isOpen: true }}
        onAccepted={vi.fn()}
        onRefresh={vi.fn()}
        onCall={vi.fn()}
      />,
    );
    await receive({
      type: 'view-call',
      id: 70,
      method: 'transport.open',
      input: {
        id: '12345678-1234-1234-1234-123456789abc',
        name: 'events',
        url: 'https://example.com/events',
      },
    });
    expect(document.querySelectorAll('iframe')).toHaveLength(2);
    await act(async () => {
      addListener.mock.calls[0][0]({ origins: ['https://example.com/*'] });
    });
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
    expect(channels[0].port1.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'view-event',
        event: expect.objectContaining({ source: 'transport', type: 'error' }),
      }),
    );
    view.unmount();
    expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0][0]);
  } finally {
    chrome.permissions = permissions;
  }
});

it('keeps an external host modal in charge of Escape without restarting its accepted view', async () => {
  const onCall = vi.fn(async () => {});
  const props = {
    selected,
    isOpen: true,
    context: { isOpen: true },
    onAccepted: vi.fn(),
    onRefresh: vi.fn(),
    onCall,
  };
  const view = render(<BrowserView {...props} keyboardActive={false} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCall).not.toHaveBeenCalled();
  view.rerender(<BrowserView {...props} keyboardActive />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCall).toHaveBeenCalledWith('close', {});
  expect(channels).toHaveLength(1);
});

it('preserves nested login geometry, including a resize during preparation, and rejects out-of-viewport placement', async () => {
  render(
    <BrowserView
      selected={selected}
      isOpen
      context={{ isOpen: true }}
      onAccepted={vi.fn()}
      onRefresh={vi.fn()}
      onCall={vi.fn()}
    />,
  );
  await receive({ type: 'view-ready' });
  await receive({
    type: 'view-call',
    id: 80,
    method: 'login.show',
    input: { name: 'example', bounds: { left: 80, top: 80, width: 520, height: 400 } },
  });
  await receive({
    type: 'view-call',
    id: 81,
    method: 'login.bounds',
    input: { name: 'example', bounds: { left: 100, top: 100, width: 500, height: 380 } },
  });
  await act(async () => {
    ready();
  });
  const container = (await screen.findByText('hostLoginClose')).parentElement!;
  expect(container).toHaveStyle({
    left: '100px',
    top: '100px',
    width: '500px',
    height: '380px',
    transform: 'translateZ(0)',
  });
  await receive({
    type: 'view-call',
    id: 82,
    method: 'login.bounds',
    input: { name: 'example', bounds: { left: -1, top: 0, width: 5000, height: 380 } },
  });
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'view-result', id: 82, success: false }),
  );
  expect(container).toHaveStyle({ left: '100px', width: '500px' });
});

it('preserves explicit toast duration and uses the host default for invalid values', async () => {
  render(<BrowserView selected={selected} isOpen context={{}} onAccepted={vi.fn()} onRefresh={vi.fn(async () => {})} onCall={vi.fn(async () => {})} />);
  await receive({ type: 'view-call', id: 1, method: 'toast', input: { message: 'Capture failed', type: 'error', duration: 5000 } });
  expect(showToast).toHaveBeenLastCalledWith('Capture failed', 'error', 5000);
  for (const duration of [undefined, -1, NaN, Infinity, '5000']) {
    await receive({ type: 'view-call', id: 2, method: 'toast', input: { message: 'Capture failed', type: 'error', duration } });
    expect(showToast).toHaveBeenLastCalledWith('Capture failed', 'error', undefined);
  }
});
