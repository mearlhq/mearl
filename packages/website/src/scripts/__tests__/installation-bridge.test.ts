// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initInstallationBridge } from '../installation-bridge';
const catalog = {
  schemaVersion: 1,
  guide: {
    url: 'https://guide.example.test/installed.html',
  },
  presets: {
    one: { label: 'First', source: 'https://assets.example.test/one.json', origins: [] },
    two: { label: 'Second', source: 'https://assets.example.test/two.json', origins: [] },
  },
};
let send: ReturnType<typeof vi.fn>;
let originalParent: PropertyDescriptor | undefined;
const parent = { postMessage: vi.fn() };
const select = (presetId: string, origin = 'https://guide.example.test') =>
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      source: parent as any,
      data: { type: 'mearl-installation-select', schemaVersion: 1, presetId },
    }),
  );
function embed() {
  originalParent = Object.getOwnPropertyDescriptor(window, 'parent');
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parent });
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const button = () => document.querySelector<HTMLButtonElement>('[data-bridge-install]')!;
beforeEach(() => {
  document.body.innerHTML =
    '<main data-installation-bridge><p data-bridge-label></p><p data-bridge-status></p><button data-bridge-install></button></main>';
  parent.postMessage.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } }),
    ),
  );
  send = vi.fn((_id, _input, callback) => callback({ success: true, data: { connected: true } }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  if (originalParent) Object.defineProperty(window, 'parent', originalParent);
  originalParent = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('does not load the catalog when opened as a top-level page', async () => {
  await initInstallationBridge();
  expect(fetch).not.toHaveBeenCalled();
  expect(button().disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
it('does not open a view from a synthetic click in the guide', async () => {
  embed();
  await initInstallationBridge();
  select('one');
  await flush();
  button().click();
  await flush();
  expect(send.mock.calls.map(([, input]) => input.operation)).toEqual(['status']);
});
it('handles a parent selection only once after BFCache restoration', async () => {
  embed();
  await initInstallationBridge();
  window.dispatchEvent(new Event('pagehide'));
  await initInstallationBridge();
  send.mockClear();
  select('two');
  await flush();
  expect(send.mock.calls).toHaveLength(1);
  expect(send.mock.calls[0][1].presetId).toBe('two');
});
it('leaves no stale enabled button if the catalog is unavailable after restoration', async () => {
  embed();
  await initInstallationBridge();
  select('one');
  await flush();
  expect(button().disabled).toBe(false);
  window.dispatchEvent(new Event('pagehide'));
  vi.mocked(fetch).mockRejectedValue(new Error('Offline'));
  await initInstallationBridge();
  expect(button().disabled).toBe(true);
  expect(document.body.textContent).toContain('安装目录暂不可用');
});

it('replays the latest parent selection after a live open, including switching back', async () => {
  embed();
  await initInstallationBridge();
  select('one');
  await flush();
  expect(document.querySelector<HTMLElement>('[data-bridge-label]')!.hidden).toBe(true);
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
  expect(send.mock.calls.map(([, input]) => [input.operation, input.presetId])).toEqual([
    ['status', 'one'],
    ['open', 'one'],
  ]);
  const next = new MouseEvent('click');
  Object.defineProperty(next, 'isTrusted', { value: true });
  button().dispatchEvent(next);
  select('one');
  select('two');
  finish();
  await flush();
  expect(send.mock.calls.at(-1)![1]).toMatchObject({ operation: 'status', presetId: 'two' });
  const count = send.mock.calls.length;
  select('one', 'https://attacker.example.test');
  await flush();
  expect(send.mock.calls).toHaveLength(count);
});

it.each([true, false, undefined])(
  'only opens installation after a click when browserReady is %s',
  async browserReady => {
    embed();
    send.mockImplementation((_id, input, callback) =>
      callback(
        input.operation === 'status' && browserReady !== undefined
          ? { success: true, data: { connected: true, browserReady } }
          : { success: false, error: 'INSTALLATION_SOURCE_DENIED' },
      ),
    );
    await initInstallationBridge();
    select('one');
    await flush();
    select('two');
    await flush();
    expect(send.mock.calls.map(([, input]) => input.operation)).toEqual(['status', 'status']);
    expect(button().disabled).toBe(false);
    const status = document.querySelector('[data-bridge-status]')!;
    if (browserReady === undefined) expect(status.textContent).toBe('');
    else expect(status.textContent).not.toContain('不可用');

    const click = new MouseEvent('click');
    Object.defineProperty(click, 'isTrusted', { value: true });
    button().dispatchEvent(click);
    await flush();
    expect(send.mock.calls.at(-1)![1]).toMatchObject({ operation: 'open', presetId: 'two' });
    expect(status.textContent).toContain('当前安装配置不可用');
  },
);
