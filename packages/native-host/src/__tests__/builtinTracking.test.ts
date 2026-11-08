import { beforeEach, expect, it, vi } from 'vitest';
import { getTrackingCapability } from '../capability-contracts.js';
import { nativeCapabilities } from '../native-capability-services.js';

beforeEach(() => vi.restoreAllMocks());
it('provides base tracking parsing without an installed capability', () => {
  vi.spyOn(nativeCapabilities, 'get').mockReturnValue(undefined);
  const parser = getTrackingCapability();
  const url = 'https://gm.mmstat.com/aplus.clk?gmkey=CLK&gokey=spm%3D1.2.button.submit';
  expect(parser.matches(url)).toBe(true);
  expect(parser.parse(url, undefined, { sequence: 2, now: 1000 })).toMatchObject([{ source: 'aplus', name: '1.2.button.submit', id: 'aplus-2-1000' }]);
  expect(parser.matches('https://example.com/api')).toBe(false);
});
it('lets an installed implementation override the base parser', () => {
  const parser = { matches: () => true, parse: () => [] };
  vi.spyOn(nativeCapabilities, 'get').mockReturnValue(() => parser);
  expect(getTrackingCapability()).toBe(parser);
});
