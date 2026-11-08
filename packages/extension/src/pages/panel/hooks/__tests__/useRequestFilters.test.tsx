import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createRequestStreamCapture } from '@mearl/browser-core';
import { useRequestFilters } from '../useRequestFilters';

vi.mock('../useLocalStorage', () => ({ useLocalStorage: () => [['sample'], vi.fn()] }));

it('keeps an annotated delegated stream in its selected namespace alongside ordinary requests', () => {
  const bridge = createRequestStreamCapture({
    id: 3, api: 'opaque.query', namespace: 'sample', environment: 'qa-east',
    url: 'https://example.test/events', source: 'protocol', method: 'POST', captureSequence: 3,
  }).request;
  const ordinary = { ...bridge, id: 1, isSSE: false };
  const other = { ...ordinary, id: 2, namespace: 'other' };
  // Preparation may fail before the protocol can provide an annotation.
  const failed = { ...ordinary, id: 4, namespace: undefined, status: 500, statusText: 'Authorization failed' };
  const { result } = renderHook(() => useRequestFilters([ordinary, other, bridge, failed], true));
  expect(result.current.availableNamespaces).toContainEqual({ ns: 'sample', count: 2 });
  expect(result.current.displayedRequests.map(request => request.id)).toEqual([1, 3, 4]);
});
