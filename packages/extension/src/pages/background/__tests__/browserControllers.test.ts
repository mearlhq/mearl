import { beforeEach, expect, it, vi } from 'vitest';
import { BROWSER_CONTROLLER_HOST_TARGET } from '../../../shared/browserCapabilityMessages';
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  read: vi.fn(),
  controllers: vi.fn(),
  readController: vi.fn(),
  forget: vi.fn(),
  view: vi.fn(),
}));
vi.mock('../browserViewInstances', () => ({
  openBrowserViewInstance: mocks.open,
  readBrowserViewInstance: mocks.read,
  listBrowserViewControllers: mocks.controllers,
  readBrowserViewController: mocks.readController,
  forgetBrowserViewController: mocks.forget,
}));
vi.mock('../offscreenDocument', () => ({
  withOffscreenDocument: (operation: () => unknown) => operation(),
}));
vi.mock('../browserViewService', () => ({ handleBrowserView: mocks.view }));
const id = '11111111-1111-4111-8111-111111111111';
const instance = {
  id,
  documentId: 'owner',
  selected: {
    bundleId: 'example',
    revision: 'accepted',
    slot: 'captureController',
    definition: { actions: {} },
  },
  handlers: {},
  controller: { token: 'accepted-token', html: '<p>accepted</p>' },
};
const owner = { id: 'extension', documentId: 'owner', url: 'chrome-extension://extension/ui.html' };
let live: boolean;
let receive: (message: any, sender: any, callback: (value: any) => void) => unknown;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  live = true;
  mocks.controllers.mockResolvedValue([instance]);
  mocks.read.mockResolvedValue(instance);
  mocks.readController.mockResolvedValue(instance);
  mocks.forget.mockResolvedValue(undefined);
  mocks.view.mockResolvedValue({ success: true, data: 'accepted result' });
  chrome.runtime.id = 'extension';
  chrome.runtime.getURL = file => 'chrome-extension://extension/' + file;
  chrome.runtime.getContexts = vi.fn(async () => (live ? [{ documentId: 'owner' }] : [])) as any;
  chrome.runtime.onConnect = { addListener: vi.fn() } as any;
  chrome.runtime.onMessage = {
    addListener: (listener: typeof receive) => {
      receive = listener;
    },
  } as any;
  chrome.runtime.sendMessage = vi.fn(async () => ({ success: true })) as any;
  chrome.permissions = { onRemoved: { addListener: vi.fn() } } as any;
  chrome.offscreen = { hasDocument: vi.fn(async () => true) } as any;
});
it('keeps accepted handlers until cleanup finishes and does not retire live documents after a worker restart', async () => {
  const { reconcileBrowserControllers } = await import('../browserControllers');
  await reconcileBrowserControllers();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  let finish!: (value: unknown) => void;
  vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }) as any,
  );
  live = false;
  const cleanup = reconcileBrowserControllers();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(mocks.forget).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
    target: 'mearl-browser-controller-offscreen',
    operation: 'close',
    id,
    token: instance.controller.token,
  });
  finish({ success: true });
  await cleanup;
  expect(mocks.forget).toHaveBeenCalledWith(id, instance.controller.token);
});
it('accepts host calls only from the offscreen document and pins identity over untrusted call fields', async () => {
  const { initializeBrowserControllers } = await import('../browserControllers');
  initializeBrowserControllers();
  const request = {
    target: BROWSER_CONTROLLER_HOST_TARGET,
    id,
    token: instance.controller.token,
    method: 'invoke',
    input: {
      instanceId: 'other',
      bundleId: 'other',
      revision: 'other',
      slot: 'requestImport',
      operation: 'close',
      action: 'cleanup',
    },
  };
  const response = vi.fn();
  expect(receive(request, owner, response)).toBeUndefined();
  expect(mocks.readController).not.toHaveBeenCalled();
  expect(
    receive(
      request,
      { id: 'extension', url: chrome.runtime.getURL('src/pages/offscreen/index.html') },
      response,
    ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(response).toHaveBeenCalledWith({ success: true, data: 'accepted result' }),
  );
  expect(mocks.readController).toHaveBeenCalledWith(id, instance.controller.token);
  expect(mocks.view).toHaveBeenCalledWith(
    {
      instanceId: id,
      bundleId: 'example',
      revision: 'accepted',
      slot: 'captureController',
      operation: 'invoke',
      action: 'cleanup',
    },
    expect.objectContaining({ documentId: 'owner' }),
  );
});
it('waits for the preceding same-document session before accepting a replacement', async () => {
  const { handleBrowserController } = await import('../browserControllers');
  let finish!: (value: unknown) => void;
  vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }) as any,
  );
  mocks.view.mockResolvedValue({ success: true, data: {} });
  const replacementId = '22222222-2222-4222-8222-222222222222';
  mocks.read.mockResolvedValue({ ...instance, id: replacementId });
  const replacement = handleBrowserController(
    {
      operation: 'controllerStart',
      instanceId: replacementId,
      bundleId: 'example',
      revision: 'accepted',
      slot: 'captureController',
      bootstrap: { locale: 'en', context: {} },
    },
    owner,
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.forget).not.toHaveBeenCalled();
  finish({ success: true });
  expect(await replacement).toMatchObject({ success: true });
  expect(mocks.forget).toHaveBeenCalledWith(id, instance.controller.token);
  expect(mocks.open).toHaveBeenCalledOnce();
  const operations = vi
    .mocked(chrome.runtime.sendMessage)
    .mock.calls.map(([message]: any[]) => message.operation);
  expect(operations).toEqual(['close', 'start']);
});
