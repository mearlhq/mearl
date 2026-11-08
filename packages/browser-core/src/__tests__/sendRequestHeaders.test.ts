import { describe, expect, it } from 'vitest';
import { getSendRequestSourceHeaders } from '../sendRequestHeaders.js';

describe('getSendRequestSourceHeaders', () => {
  it('keeps the existing source header defaults', () => {
    expect(getSendRequestSourceHeaders(new URL('https://api.example.com/data'))).toEqual({
      referer: 'https://api.example.com/mearl',
      origin: 'https://api.example.com',
    });
  });

  it('allows callers to override or remove source headers', () => {
    expect(
      getSendRequestSourceHeaders(new URL('https://api.example.com/data'), {
        Referer: 'https://www.example.com/video/1',
        Origin: '',
      }),
    ).toEqual({
      referer: 'https://www.example.com/video/1',
      origin: undefined,
    });
  });
});
