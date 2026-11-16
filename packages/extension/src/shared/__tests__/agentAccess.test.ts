import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_ACCESS_PREFERENCE, readAgentAccess } from '../agentAccess';

describe('browser-local Agent access', () => {
  let local: Record<string, unknown>;

  beforeEach(() => {
    local = {};
    chrome.storage.local.get = vi.fn(async () => local);
    chrome.storage.local.set = vi.fn().mockResolvedValue(undefined);
    chrome.storage.sync = { get: vi.fn().mockResolvedValue({ agentEnabled: true }) } as any;
  });
  it('restores Agent access for profiles with an old automatic Provider assignment', async () => {
    local = { 'agent-access-providers': ['ego'] };
    expect(await readAgentAccess()).toBe(true);
    expect(await readAgentAccess([])).toBe(true);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
  it('honors the explicit local switch and the synchronized preference', async () => {
    expect(await readAgentAccess([], false)).toBe(false);
    local = { [AGENT_ACCESS_PREFERENCE]: false };
    expect(await readAgentAccess([])).toBe(false);
  });
  it('honors a live policy from an older Native Host during a staggered upgrade', async () => {
    expect(await readAgentAccess(['ego'])).toBe(false);
    local = { [AGENT_ACCESS_PREFERENCE]: true };
    expect(await readAgentAccess(['ego'])).toBe(true);
  });
});
