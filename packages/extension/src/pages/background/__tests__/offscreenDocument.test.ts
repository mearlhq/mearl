import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  vi.resetModules();
  let exists = false;
  const offscreen = {
    hasDocument: vi.fn(async () => exists),
    createDocument: vi.fn(async () => {
      exists = true;
    }),
    closeDocument: vi.fn(async () => {
      exists = false;
    }),
  };
  vi.stubGlobal('chrome', {
    offscreen,
    runtime: { sendMessage: vi.fn(async () => ({ held: false })) },
  });
  return { offscreen, ...(await import('../offscreenDocument')) };
}
it('shares one document across overlapping operations and closes it after the last user', async () => {
  const { offscreen, withOffscreenDocument } = await fixture();
  const first = deferred(),
    second = deferred(),
    started = vi.fn();
  const a = withOffscreenDocument(async () => {
    started();
    await first.promise;
    return 'sso';
  });
  const b = withOffscreenDocument(async () => {
    started();
    await second.promise;
    return 'service';
  });
  await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2));
  expect(offscreen.createDocument).toHaveBeenCalledTimes(1);
  first.resolve();
  expect(await a).toBe('sso');
  expect(offscreen.closeDocument).not.toHaveBeenCalled();
  second.resolve();
  expect(await b).toBe('service');
  expect(offscreen.closeDocument).toHaveBeenCalledTimes(1);
});
it('waits for a close already in progress before acquiring a fresh document', async () => {
  const { offscreen, withOffscreenDocument } = await fixture();
  const closing = deferred(),
    closeStarted = deferred();
  offscreen.closeDocument.mockImplementationOnce(async () => {
    closeStarted.resolve();
    await closing.promise;
  });
  const first = withOffscreenDocument(async () => 1);
  await closeStarted.promise;
  offscreen.hasDocument.mockImplementation(async () => false);
  const operation = vi.fn(async () => 2);
  const second = withOffscreenDocument(operation);
  await Promise.resolve();
  expect(operation).not.toHaveBeenCalled();
  closing.resolve();
  expect(await first).toBe(1);
  expect(await second).toBe(2);
  expect(offscreen.createDocument).toHaveBeenCalledTimes(2);
});
it('releases failed acquisitions/operations and preserves their error through cleanup failures', async () => {
  const { offscreen, withOffscreenDocument } = await fixture();
  offscreen.createDocument.mockRejectedValueOnce(new Error('create failed'));
  await expect(withOffscreenDocument(async () => 1)).rejects.toThrow('create failed');
  offscreen.closeDocument.mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(
    withOffscreenDocument(async () => {
      throw new Error('operation failed');
    }),
  ).rejects.toThrow('operation failed');
  await expect(withOffscreenDocument(async () => 3)).resolves.toBe(3);
});

it('retains resident work after worker restart and closes after its final lease ends', async () => {
  const { offscreen, withOffscreenDocument } = await fixture();
  offscreen.hasDocument.mockResolvedValue(true);
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ held: true });
  await withOffscreenDocument(async () => 'unrelated request');
  expect(offscreen.createDocument).not.toHaveBeenCalled();
  expect(offscreen.closeDocument).not.toHaveBeenCalled();
  await withOffscreenDocument(async () => 'cleanup completed');
  expect(offscreen.closeDocument).toHaveBeenCalledOnce();
});
it('keeps active work when a lifecycle probe temporarily fails', async () => {
  const { offscreen, withOffscreenDocument } = await fixture();
  vi.mocked(chrome.runtime.sendMessage).mockRejectedValueOnce(
    new Error('worker observation changed'),
  );
  await withOffscreenDocument(async () => 1);
  expect(offscreen.closeDocument).not.toHaveBeenCalled();
  await withOffscreenDocument(async () => 2);
  expect(offscreen.closeDocument).toHaveBeenCalledOnce();
});
