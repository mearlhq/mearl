import { expect, it } from 'vitest';
import { parseBrowserListParams } from './browserDiscovery.js';

it('keeps ordinary listing and prevents partial discovery options from being silently ignored', () => {
  expect(parseBrowserListParams({})).toBeUndefined();
  const params = { provider: 'ego', launchForm: { variant: 'attach', values: { spaceId: '8' } } };
  expect(parseBrowserListParams(params)).toEqual(params);
  expect(parseBrowserListParams({ provider: 'org.fixture_test', launchForm: { variant: '', values: {} } })).toEqual({ provider: 'org.fixture_test', launchForm: { variant: '', values: {} } });
  for (const request of [{ provider: 'ego' }, { launchForm: { values: {} } }, { ...params, extra: true }, { provider: 'ego', launchForm: { variant: 1, values: {} } }])
    expect(() => parseBrowserListParams(request)).toThrow();
});
