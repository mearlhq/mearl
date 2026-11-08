import { expect, it, vi } from 'vitest';
import { PluginModelCatalog } from '../pluginModelCatalog.js';

it('coalesces discovery, caches successful results and isolates caller mutations', async () => {
  let resolve!: (value: any) => void;
  const discover = vi.fn(
    () =>
      new Promise<any>(done => {
        resolve = done;
      }),
  );
  const catalog = new PluginModelCatalog(discover);
  const first = catalog.list(),
    second = catalog.list();
  expect(discover).toHaveBeenCalledOnce();
  resolve([{ id: 'local-model', displayName: 'Local model' }]);
  const value = await first;
  value.models[0].id = 'mutated';
  expect((await second).models[0].id).toBe('local-model');
  expect((await catalog.list()).models[0].id).toBe('local-model');
  expect(discover).toHaveBeenCalledOnce();
  await catalog.close();
});
it('does not cache failures and cancels pending discovery on close', async () => {
  const discover = vi
    .fn()
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockImplementation(
      signal =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    );
  const catalog = new PluginModelCatalog(discover);
  await expect(catalog.list()).rejects.toThrow('Unavailable');
  const pending = catalog.list();
  const assertion = expect(pending).rejects.toBeDefined();
  await catalog.close();
  await assertion;
  expect(discover).toHaveBeenCalledTimes(2);
  expect(() => catalog.list('other')).toThrow();
});

it('returns the last catalog immediately while coalescing an expired refresh', async () => {
  let now = 0,
    resolve!: (value: any) => void;
  const discover = vi
    .fn()
    .mockResolvedValueOnce([{ id: 'old', displayName: 'Old' }])
    .mockImplementation(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
  const catalog = new PluginModelCatalog(discover, () => now);
  await catalog.list();
  now = 120001;
  expect((await catalog.list()).models[0].id).toBe('old');
  expect((await catalog.list()).models[0].id).toBe('old');
  expect(discover).toHaveBeenCalledTimes(2);
  resolve([{ id: 'new', displayName: 'New' }]);
  await vi.waitFor(async () => expect((await catalog.list()).models[0].id).toBe('new'));
  await catalog.close();
});
it('preserves a usable catalog after refresh failure and backs off repeated discovery', async () => {
  let now = 0;
  const discover = vi
    .fn()
    .mockResolvedValueOnce([{ id: 'saved', displayName: 'Saved' }])
    .mockRejectedValue(new Error('Offline'));
  const catalog = new PluginModelCatalog(discover, () => now);
  await catalog.list();
  now = 120001;
  expect((await catalog.list()).models[0].id).toBe('saved');
  await Promise.resolve();
  await Promise.resolve();
  expect((await catalog.list()).models[0].id).toBe('saved');
  expect(discover).toHaveBeenCalledTimes(2);
  now += 30001;
  expect((await catalog.list()).models[0].id).toBe('saved');
  expect(discover).toHaveBeenCalledTimes(3);
  await catalog.close();
});
