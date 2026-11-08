// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initInstallationBridge } from '../installation-bridge';
const catalog = {
  schemaVersion: 1,
  guide: {
    url: 'https://guide.example.test/installed.html',
    registry: 'https://registry.example.test/',
  },
  presets: {
    one: { label: 'First', source: 'https://assets.example.test/one.json', origins: [] },
    two: { label: 'Second', source: 'https://assets.example.test/two.json', origins: [] },
  },
};
let send: ReturnType<typeof vi.fn>;
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const choice = () => document.querySelector<HTMLSelectElement>('[data-bridge-choice]')!;
const button = () => document.querySelector<HTMLButtonElement>('[data-bridge-install]')!;
beforeEach(() => {
  document.body.innerHTML =
    '<main data-installation-bridge><h2 data-bridge-label></h2><p data-bridge-status></p><button data-bridge-install></button><a data-bridge-fallback></a><select data-bridge-choice></select><div data-bridge-heading></div></main>';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } }),
    ),
  );
  send = vi.fn((_id, input, callback) => callback({ success: true, data: { connected: true } }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('keeps catalog labels as text and never opens a view from a synthetic click', async () => {
  await initInstallationBridge();
  expect(choice().options).toHaveLength(2);
  button().click();
  await flush();
  expect(send.mock.calls.map(([, input]) => input.operation)).toEqual(['status']);
});
it('restores one selector and fresh listeners after BFCache without duplicate options', async () => {
  await initInstallationBridge();
  window.dispatchEvent(new Event('pagehide'));
  await initInstallationBridge();
  expect(choice().options).toHaveLength(2);
  send.mockClear();
  choice().value = 'two';
  choice().dispatchEvent(new Event('change'));
  await flush();
  expect(send.mock.calls).toHaveLength(1);
  expect(send.mock.calls[0][1].presetId).toBe('two');
});
it('leaves no stale enabled button if the catalog is unavailable after restoration', async () => {
  await initInstallationBridge();
  window.dispatchEvent(new Event('pagehide'));
  vi.mocked(fetch).mockRejectedValue(new Error('Offline'));
  await initInstallationBridge();
  expect(button().disabled).toBe(true);
  expect(choice().options).toHaveLength(0);
  expect(document.body.textContent).toContain('安装目录暂不可用');
});

it('replays the latest parent selection after a live open, including switching back', async () => {
  const parent = { postMessage: vi.fn() };
  const original = Object.getOwnPropertyDescriptor(window, 'parent');
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parent });
  document.querySelector<HTMLElement>('[data-installation-bridge]')!.dataset.embedded = 'true';
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const select = (id: string) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://guide.example.test',
        source: parent as any,
        data: { type: 'mearl-installation-select', schemaVersion: 1, presetId: id },
      }),
    );
  try {
    await initInstallationBridge();
    select('one');
    await flush();
    let finish!: () => void;
    send.mockImplementation((_id, input, callback) =>
      input.operation === 'open'
        ? (finish = () => callback({ success: true, data: {} }))
        : callback({ success: true, data: {} }),
    );
    const click = new MouseEvent('click');
    Object.defineProperty(click, 'isTrusted', { value: true });
    button().dispatchEvent(click);
    select('two');
    select('one');
    finish();
    await flush();
    expect(document.querySelector('[data-bridge-label]')!.textContent).toBe('First');
    const next = new MouseEvent('click');
    Object.defineProperty(next, 'isTrusted', { value: true });
    button().dispatchEvent(next);
    select('one');
    select('two');
    finish();
    await flush();
    expect(document.querySelector('[data-bridge-label]')!.textContent).toBe('Second');
    expect(send.mock.calls.at(-1)![1]).toMatchObject({ operation: 'status', presetId: 'two' });
    const count = send.mock.calls.length;
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://attacker.example.test',
        source: parent as any,
        data: { type: 'mearl-installation-select', schemaVersion: 1, presetId: 'one' },
      }),
    );
    await flush();
    expect(send.mock.calls).toHaveLength(count);
  } finally {
    window.dispatchEvent(new Event('pagehide'));
    if (original) Object.defineProperty(window, 'parent', original);
  }
});

it('reports the detected extension version only to the configured guide parent', async () => {
  const parent = { postMessage: vi.fn() };
  const original = Object.getOwnPropertyDescriptor(window, 'parent');
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parent });
  document.querySelector<HTMLElement>('[data-installation-bridge]')!.dataset.embedded = 'true';
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  send.mockImplementation((_id, _input, callback) =>
    callback({ success: true, data: { connected: true, version: '3.0.0-beta.5' } }),
  );
  try {
    await initInstallationBridge();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://guide.example.test',
        source: parent as any,
        data: { type: 'mearl-installation-select', schemaVersion: 1, presetId: 'one' },
      }),
    );
    await flush();
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: 'mearl-installation-status', schemaVersion: 1, version: '3.0.0-beta.5' },
      'https://guide.example.test',
    );
  } finally {
    window.dispatchEvent(new Event('pagehide'));
    if (original) Object.defineProperty(window, 'parent', original);
  }
});

it.each([true, false])(
  'checks for initial installation only on the embedded guide when browserReady is %s',
  async browserReady => {
    const parent = { postMessage: vi.fn() };
    const original = Object.getOwnPropertyDescriptor(window, 'parent');
    Object.defineProperty(window, 'parent', { configurable: true, get: () => parent });
    document.querySelector<HTMLElement>('[data-installation-bridge]')!.dataset.embedded = 'true';
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    send.mockImplementation((_id, input, callback) =>
      callback(
        input.operation === 'status'
          ? { success: true, data: { connected: true, browserReady } }
          : { success: false, error: 'INVALID_INSTALLATION_REQUEST' },
      ),
    );
    const select = (presetId: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://guide.example.test',
          source: parent as any,
          data: { type: 'mearl-installation-select', schemaVersion: 1, presetId },
        }),
      );
    try {
      await initInstallationBridge();
      select('one');
      await flush();
      select('two');
      await flush();
      expect(send.mock.calls.map(([, input]) => input.operation)).toEqual(
        browserReady ? ['status', 'status'] : ['status', 'openIfMissing', 'status'],
      );
      expect(button().disabled).toBe(false);
    } finally {
      window.dispatchEvent(new Event('pagehide'));
      if (original) Object.defineProperty(window, 'parent', original);
    }
  },
);
