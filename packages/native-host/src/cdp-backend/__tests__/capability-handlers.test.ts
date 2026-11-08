import { describe, expect, it, vi } from 'vitest';
import type { CdpSession } from '../cdp-session.js';
const catalog = vi.hoisted(() => ({ listInstalledAppProfiles: vi.fn().mockResolvedValue({ profiles: [], errors: [] }) }));
vi.mock('../../app-profile-catalog.js', () => catalog);
vi.mock('../controlled-indicator.js', () => ({ ensureControlledIndicator: vi.fn() }));
import { ensureControlledIndicator } from '../controlled-indicator.js';
import '../capability-handlers.js';
import { dispatchCdpAction } from '../action-registry.js';

describe('CDP capability discovery', () => {
  it('queries registered metadata without resolving or changing a page', async () => {
    const getPageSession = vi.fn();
    const result = await dispatchCdpAction({ getPageSession } as unknown as CdpSession, 'get_capabilities', {});
    expect(result.actions).toContain('get_capabilities');
    expect(catalog.listInstalledAppProfiles).toHaveBeenCalledWith({ refresh: false });
    expect(getPageSession).not.toHaveBeenCalled();
    expect(ensureControlledIndicator).not.toHaveBeenCalled();
  });
});
