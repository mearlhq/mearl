import { expect, it } from 'vitest';
import { parseCaptureIdentity } from '../captureIdentity';

it('preserves the generic identity contract and opaque provider claims', () => {
  const identity = { subject: 'customer:1', complete: true, displayName: 'User', custom: 1 };
  expect(parseCaptureIdentity(identity)).toEqual(identity);
  expect(parseCaptureIdentity({ subject: 'customer:2', complete: false })).toEqual({ subject: 'customer:2', complete: false });
});
it.each([null, [], { id: 'user', name: 'User' }, { subject: 123, complete: true }, { subject: 'user' }, { subject: 'user', complete: true, displayName: {} }])('rejects identity data outside the host contract %#', value => expect(() => parseCaptureIdentity(value)).toThrow());
