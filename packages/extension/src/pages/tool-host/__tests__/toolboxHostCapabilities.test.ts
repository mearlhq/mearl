import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invokeToolboxHostCapability } from '../toolboxHostCapabilities';

const mocks = vi.hoisted(() => ({
  requestToolbox: vi.fn(),
  requestNativeHost: vi.fn(),
  read: vi.fn(),
  writeImage: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../popup/toolboxRequest', () => ({ requestToolbox: mocks.requestToolbox }));
vi.mock('../../sidepanel/nativeHostRequest', () => ({
  requestNativeHost: mocks.requestNativeHost,
}));
vi.mock('../toolboxClipboard', () => ({
  readToolboxClipboard: mocks.read,
  writeToolboxClipboardImage: mocks.writeImage,
}));
vi.mock('../../panel/utils/toast', () => ({ showToast: mocks.toast }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', { tabs: { create: vi.fn(), query: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

it('keeps durable operations scoped to the hosting tool', async () => {
  const input = { command: 'publish', input: { id: 'other-tool', value: 42 }, id: 'other-tool' };
  mocks.requestToolbox.mockResolvedValue({ state: 'running' });
  await expect(
    invokeToolboxHostCapability('plugin:sample', 'host.task.start', input),
  ).resolves.toEqual({ state: 'running' });
  expect(mocks.requestToolbox).toHaveBeenCalledWith('toolbox_task', {
    operation: 'start',
    id: 'plugin:sample',
    command: 'publish',
    input: input.input,
  });
  await invokeToolboxHostCapability('plugin:sample', 'host.task.get', {
    taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
    id: 'other-tool',
  });
  expect(mocks.requestToolbox).toHaveBeenLastCalledWith('toolbox_task', {
    operation: 'get',
    id: 'plugin:sample',
    taskId: 'pt_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222',
  });
});
it.each([
  'chrome.runtime.reload',
  'host.chrome.runtime.reload',
  'host.native.send',
  'host.__proto__',
])('rejects unregistered capability %s without forwarding', async capability => {
  await expect(invokeToolboxHostCapability('sample', capability, {})).rejects.toThrow(
    'Unknown toolbox host capability',
  );
  expect(mocks.requestNativeHost).not.toHaveBeenCalled();
  expect(mocks.requestToolbox).not.toHaveBeenCalled();
});
it.each(['javascript:alert(1)', 'https://user:secret@example.test/', 'file:///tmp/example'])(
  'rejects invalid external link %s before Chrome',
  async url => {
    await expect(invokeToolboxHostCapability('sample', 'host.link.open', { url })).rejects.toThrow(
      'HTTP or HTTPS',
    );
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  },
);
it('returns only an active HTTP page as a tool target', async () => {
  vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
    { id: 7, url: 'chrome://extensions/' },
  ] as chrome.tabs.Tab[]);
  await expect(invokeToolboxHostCapability('sample', 'host.tab.active', {})).resolves.toBeNull();
  vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
    { id: 7, url: 'https://example.test/', title: 'Page' },
  ] as chrome.tabs.Tab[]);
  await expect(invokeToolboxHostCapability('sample', 'host.tab.active', {})).resolves.toEqual({
    tabId: 7,
    url: 'https://example.test/',
    title: 'Page',
  });
});

it.each([false, true])(
  'reads scoped page reply resources and checks integrity (tampered=%s)',
  async tampered => {
    const { webcrypto, createHash } = await import('node:crypto');
    vi.stubGlobal('crypto', webcrypto);
    const value = { text: '设计😀'.repeat(60000) };
    const bytes = Buffer.from(JSON.stringify(value));
    const reference = {
      kind: 'resource',
      resultId: 'result',
      bytes: bytes.length,
      chunks: Math.ceil(bytes.length / (192 * 1024)),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    mocks.requestToolbox.mockImplementation(async (action, data) => {
      expect(action).toBe('toolbox_page');
      expect(data.id).toBe('plugin:sample');
      if (data.operation === 'send') return reference;
      if (data.operation === 'result_release') return { released: true };
      const index = data.input.index;
      const part = Buffer.from(bytes.subarray(index * 192 * 1024, (index + 1) * 192 * 1024));
      if (tampered && index === 0) part[0] = 32;
      return { ...reference, index, data: part.toString('base64') };
    });
    const pending = invokeToolboxHostCapability('plugin:sample', 'host.page.send', {
      instanceId: 'page',
      message: {},
    });
    if (tampered) await expect(pending).rejects.toThrow('integrity');
    else await expect(pending).resolves.toEqual(value);
    expect(mocks.requestToolbox).toHaveBeenLastCalledWith('toolbox_page', {
      id: 'plugin:sample',
      operation: 'result_release',
      input: { resultId: 'result' },
    });
  },
);

it('scopes state and model capabilities to the hosting plugin', async () => {
  mocks.requestToolbox.mockResolvedValue({ kind: 'value', value: { version: 'a:0' } });
  expect(
    await invokeToolboxHostCapability('plugin:sample', 'host.state.get', {
      collection: 'settings',
      key: 'value',
      id: 'other',
    }),
  ).toEqual({ version: 'a:0' });
  expect(mocks.requestToolbox).toHaveBeenLastCalledWith('toolbox_state', {
    id: 'plugin:sample',
    operation: 'get',
    input: { collection: 'settings', key: 'value', id: 'other' },
  });
  await invokeToolboxHostCapability('plugin:sample', 'host.state.getMany', {
    collection: 'settings',
    keys: ['a', 'b'],
  });
  expect(mocks.requestToolbox).toHaveBeenLastCalledWith('toolbox_state', {
    id: 'plugin:sample',
    operation: 'get-many',
    input: { collection: 'settings', keys: ['a', 'b'] },
  });
  await invokeToolboxHostCapability('plugin:sample', 'host.model.list', { provider: 'codex' });
  expect(mocks.requestToolbox).toHaveBeenLastCalledWith('toolbox_model', {
    id: 'plugin:sample',
    operation: 'list',
    input: { provider: 'codex' },
  });
  mocks.requestToolbox.mockResolvedValue({ taskId: 'task' });
  await expect(
    invokeToolboxHostCapability('plugin:sample', 'host.model.start', { request: {} }),
  ).resolves.toEqual({ taskId: 'task' });
  expect(mocks.requestToolbox).toHaveBeenLastCalledWith('toolbox_model', {
    id: 'plugin:sample',
    operation: 'start',
    input: { request: {} },
  });
  await expect(invokeToolboxHostCapability('plugin:sample', 'host.model.run', {})).rejects.toThrow(
    'Invalid model',
  );
});

it('keeps diagnostic exports inside the hosting plugin scope', async () => {
  await invokeToolboxHostCapability('plugin:sample', 'host.task.diagnose', {
    includeErrorMessages: true,
  });
  expect(mocks.requestToolbox).toHaveBeenCalledWith('toolbox_task', {
    operation: 'diagnose',
    id: 'plugin:sample',
    includeErrorMessages: true,
  });
  mocks.requestToolbox.mockClear();
  await expect(
    invokeToolboxHostCapability('plugin:sample', 'host.task.diagnose', { plugin: 'other' }),
  ).rejects.toThrow('Invalid diagnostic options');
  expect(mocks.requestToolbox).not.toHaveBeenCalled();
});
