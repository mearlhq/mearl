import { expect, it } from 'vitest';
import { findSseOverride } from '../sseOverrideMatch';
it('uses exact installed names and rejects prefix or query-string coincidences', () => {
  const override = { apiName: 'sample.foo.get' };
  expect(findSseOverride([override], { url: 'https://example.test/sample.foo.getDetail/', apiName: 'sample.foo.getDetail' })).toBeUndefined();
  expect(findSseOverride([override], { url: 'https://example.test/unrelated?text=sample.foo.get' })).toBeUndefined();
  expect(findSseOverride([override], { url: 'https://example.test/endpoint', apiName: 'sample.foo.get' })).toBe(override);
});
it('supports an explicitly saved URL without an installed classifier', () => {
  const override = { apiName: 'chosen name', url: 'https://example.test/stream?old=1' };
  expect(findSseOverride([override], { url: 'https://example.test/stream?new=2' })).toBe(override);
  expect(findSseOverride([override], { url: 'https://example.test/streamExtra' })).toBeUndefined();
});
