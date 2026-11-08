import { describe, expect, it, vi } from 'vitest';
import { syncResponseCookies } from '../response-cookies.js';

describe('response cookie synchronization', () => {
  it('applies separate cookies with correct scope, expiry precedence, deletion and HttpOnly', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ success: true });
    const session = { client: { sendCommand } } as any;
    const before = Date.now() / 1000;
    const result = await syncResponseCookies(session, 'https://app.example.com/api/refresh', [
      'session=renewed; HttpOnly; Secure; SameSite=Lax',
      'shared=value; Domain=example.com; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
      'short=value; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'deleted=; Path=/; Max-Age=0',
    ]);
    expect(result).toEqual({ updatedCount: 4, rejectedCount: 0, failedCount: 0 });
    expect(sendCommand.mock.calls[0]).toEqual([
      'Network.setCookie',
      {
        url: 'https://app.example.com/api/refresh',
        name: 'session',
        value: 'renewed',
        path: '/api',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    expect(sendCommand.mock.calls[1]![1]).toMatchObject({
      domain: '.example.com',
      path: '/',
      expires: Date.parse('2037-10-21T07:28:00Z') / 1000,
    });
    expect(sendCommand.mock.calls[2]![1].expires).toBeGreaterThanOrEqual(before + 60);
    expect(sendCommand.mock.calls[2]![1].expires).toBeLessThanOrEqual(Date.now() / 1000 + 60);
    expect(sendCommand.mock.calls[3]![1].expires).toBe(1);
  });

  it('rejects unrelated domains, public suffixes, invalid prefixes and unknown partition identity', async () => {
    const sendCommand = vi.fn();
    const result = await syncResponseCookies(
      { client: { sendCommand } } as any,
      'https://app.example.com/api',
      [
        'session=secret; Domain=other.com',
        'session=secret; Domain=com',
        '__Host-session=secret; Secure; Domain=example.com; Path=/',
        'session=secret; Secure; Partitioned',
      ],
    );
    expect(result).toEqual({ updatedCount: 0, rejectedCount: 4, failedCount: 0 });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('reports failed browser writes without discarding a successful business response or cookie values', async () => {
    const sendCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('private cookie data'))
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });
    const result = await syncResponseCookies(
      { client: { sendCommand } } as any,
      'https://example.com/',
      ['a=secret', 'b=secret', 'c=secret'],
    );
    expect(result).toEqual({ updatedCount: 1, rejectedCount: 1, failedCount: 1 });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects insecure Secure cookies and SameSite=None without Secure', async () => {
    const sendCommand = vi.fn();
    expect(
      await syncResponseCookies({ client: { sendCommand } } as any, 'http://example.com/', [
        'session=secret; Secure',
        'session=secret; SameSite=None',
      ]),
    ).toEqual({ updatedCount: 0, rejectedCount: 2, failedCount: 0 });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('protects existing Secure cookies from insecure overlays including deletion and child paths', async () => {
    const sendCommand = vi.fn(async (method: string) =>
      method === 'Network.getAllCookies'
        ? {
            cookies: [
              {
                name: 'session',
                value: 'protected',
                domain: '.example.com',
                path: '/login',
                secure: true,
              },
            ],
          }
        : { success: true },
    );
    const result = await syncResponseCookies(
      { client: { sendCommand } } as any,
      'http://app.example.com/login',
      [
        'session=insecure; Path=/login',
        'session=; Path=/login; Max-Age=0',
        'session=insecure; Path=/login/child',
        'session=allowed; Path=/',
        'other=allowed; Path=/login',
      ],
    );
    expect(result).toEqual({ updatedCount: 2, rejectedCount: 3, failedCount: 0 });
    expect(
      sendCommand.mock.calls.filter(([method]) => method === 'Network.setCookie'),
    ).toHaveLength(2);
  });

  it('reports failed protection queries without overwriting cookies or discarding the HTTP result', async () => {
    const sendCommand = vi.fn().mockRejectedValue(new Error('browser disconnected'));
    expect(
      await syncResponseCookies({ client: { sendCommand } } as any, 'http://example.com/', [
        'session=value',
      ]),
    ).toEqual({ updatedCount: 0, rejectedCount: 0, failedCount: 1 });
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith('Network.getAllCookies');
  });
});
