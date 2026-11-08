import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { QoderAgentProvider } from '../agent.js';

const loading = vi.hoisted(() => {
  let release!: () => void;
  return {
    entered: vi.fn(),
    wait: new Promise<void>(resolve => {
      release = resolve;
    }),
    release: () => release(),
  };
});
vi.mock('@agentclientprotocol/sdk', async importOriginal => {
  loading.entered();
  await loading.wait;
  return importOriginal();
});
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('Qoder lazy SDK startup', () => {
  it('keeps status lightweight and prevents a disposed startup from spawning after import', async () => {
    const provider = new QoderAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'resolveExecutable').mockResolvedValue({
      executable: '/qoder',
      error: null,
    });
    expect((await provider.getDescriptor()).available).toBe(true);
    expect(loading.entered).not.toHaveBeenCalled();
    const pending = provider.prepare();
    await vi.waitFor(() => expect(loading.entered).toHaveBeenCalledOnce());
    provider.dispose();
    loading.release();
    await expect(pending).rejects.toThrow('disposed during startup');
    expect(spawn).not.toHaveBeenCalled();
  });
});
