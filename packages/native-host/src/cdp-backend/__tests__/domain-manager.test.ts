import { describe, expect, it, vi } from 'vitest';
import { ensureCdpDomain } from '../domain-manager.js';

describe('CDP domain manager', () => {
  it('enables each domain once per page client', async () => {
    const client = {
      sendCommand: vi.fn().mockResolvedValue({}),
    } as any;

    await Promise.all([
      ensureCdpDomain(client, 'Network', { maxTotalBufferSize: 1024 }),
      ensureCdpDomain(client, 'Network'),
      ensureCdpDomain(client, 'Page'),
      ensureCdpDomain(client, 'Page'),
    ]);

    expect(client.sendCommand.mock.calls).toEqual([
      ['Network.enable', { maxTotalBufferSize: 1024 }],
      ['Page.enable', {}],
    ]);
  });

  it('allows a failed domain enable to be retried', async () => {
    const client = {
      sendCommand: vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValueOnce({}),
    } as any;

    await expect(ensureCdpDomain(client, 'Page')).rejects.toThrow('not ready');
    await expect(ensureCdpDomain(client, 'Page')).resolves.toBeUndefined();
    expect(client.sendCommand).toHaveBeenCalledTimes(2);
  });
});
