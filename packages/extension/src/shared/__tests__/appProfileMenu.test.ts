import { expect, it } from 'vitest';
import { parseAppProfileMenu } from '../appProfileMenu';

it('keeps installed order and localized labels while discarding execution data', () => {
  const entry = { id: 'example/app', label: 'Example', definition: { labels: { en: 'Example', zh_CN: '示例' }, actions: { execute: 'source' } } };
  const result = parseAppProfileMenu([entry, { id: 'second/app', label: 'Second', available: false }]);
  entry.definition.labels.zh_CN = 'changed';
  expect(result).toEqual([{ id: 'example/app', label: 'Example', definition: { labels: { en: 'Example', zh_CN: '示例' } } }, { id: 'second/app', label: 'Second', available: false }]);
});
it.each([null, {}, [{ id: 'app' }], [{ id: 'app', label: 'App', available: 'yes' }], [{ id: 'app', label: 'App' }, { id: 'app', label: 'Duplicate' }], [{ id: 'app', label: 'App', definition: { labels: { en: 123 } } }]])('rejects malformed presentation data %#', value => expect(() => parseAppProfileMenu(value)).toThrow());
