import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AGENT_ACCESS_PROVIDERS,
  AGENT_ACCESS_PREFERENCE,
  readAgentAccess,
  resolveAgentAccess,
} from '../agentAccess';

describe('browser-local Agent access', () => {
  beforeEach(() => {
    chrome.storage.local.get = vi.fn().mockResolvedValue({});
    chrome.storage.local.set = vi.fn().mockResolvedValue(undefined);
    chrome.storage.sync = { get: vi.fn().mockResolvedValue({ agentEnabled: true }) } as any;
  });
  it('keeps provider defaults isolated from synchronized preferences', async () => {
    expect(await readAgentAccess(['ego'])).toBe(false);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [AGENT_ACCESS_PROVIDERS]: ['ego'] });
    expect(resolveAgentAccess(undefined, [], true)).toBe(true);
    expect(resolveAgentAccess(undefined, ['ego'], true)).toBe(false);
    expect(resolveAgentAccess(true, ['ego'], false)).toBe(true);
  });
  it('does not restore access when a provider disappears or rewrite an unchanged assignment', async () => {
    chrome.storage.local.get = vi.fn().mockResolvedValue({ [AGENT_ACCESS_PROVIDERS]: ['ego'] });
    expect(await readAgentAccess([])).toBe(false);
    expect(await readAgentAccess(['ego'])).toBe(false);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
  it('respects the explicit local choice and legacy disabled profiles', async () => {
    chrome.storage.local.get = vi
      .fn()
      .mockResolvedValue({ [AGENT_ACCESS_PREFERENCE]: true, [AGENT_ACCESS_PROVIDERS]: ['ego'] });
    expect(await readAgentAccess([])).toBe(true);
    expect(resolveAgentAccess(undefined, undefined, false)).toBe(false);
  });
});
