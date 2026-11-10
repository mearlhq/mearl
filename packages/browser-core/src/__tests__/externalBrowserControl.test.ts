import { expect, it } from 'vitest';
import { parseExternalBrowserControl } from '../externalBrowserControl.js';

it('preserves finish retention IDs without accepting ambiguous lifecycle input', () => {
  expect(parseExternalBrowserControl({ operation: 'finish', keepTabIds: [2, 7] })).toEqual({
    operation: 'finish',
    keepTabIds: [2, 7],
  });
  for (const data of [
    null,
    { operation: 'close' },
    { operation: 'resume', keepTabIds: [] },
    { operation: 'finish', keepTabIds: [1, 1] },
    { operation: 'finish', keepTabIds: [-1] },
    { operation: 'handoff', unexpected: true },
  ])
    expect(() => parseExternalBrowserControl(data)).toThrow();
});
