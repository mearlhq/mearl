import { expect, it, vi } from 'vitest';
import { listCodexModels } from '../model-catalog.js';

it('discovers without a thread and releases the provider on success and cancellation', async () => {
  const provider = {
    listModels: vi.fn().mockResolvedValue([{ id: 'model', displayName: 'Model' }]),
    dispose: vi.fn(),
  };
  expect(await listCodexModels(new AbortController().signal, provider as any)).toHaveLength(1);
  expect(provider.dispose).toHaveBeenCalled();
  const controller = new AbortController();
  provider.listModels.mockImplementation(() => new Promise(() => {}));
  const pending = listCodexModels(controller.signal, provider as any);
  const assertion = expect(pending).rejects.toBeDefined();
  controller.abort();
  await assertion;
  expect(provider.dispose).toHaveBeenCalled();
});
