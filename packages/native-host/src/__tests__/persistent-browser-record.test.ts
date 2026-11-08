import { describe, expect, it } from 'vitest';
import { stoppedPersistentBrowserRecord } from '../persistent-browser-record.js';

describe('persistent browser records', () => {
  it('keeps restart metadata without live process identifiers after close', () => {
    expect(
      stoppedPersistentBrowserRecord(
        {
          browserId: 'managed:local-profile',
          persistent: true,
          pid: 123,
          hostPid: 456,
        },
        false,
      ),
    ).toEqual({
      browserId: 'managed:local-profile',
      persistent: true,
      pid: 0,
      hostPid: 0,
    });
  });

  it('drops restart metadata when the Profile is deleted or non-persistent', () => {
    expect(stoppedPersistentBrowserRecord({ persistent: true, pid: 123 }, true)).toBeNull();
    expect(stoppedPersistentBrowserRecord({ persistent: false, pid: 123 }, false)).toBeNull();
  });
});
