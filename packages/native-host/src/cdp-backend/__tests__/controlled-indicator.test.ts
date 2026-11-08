import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureCdpDomain } = vi.hoisted(() => ({
  ensureCdpDomain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../domain-manager.js', () => ({
  ensureCdpDomain,
}));

import { ensureControlledIndicator, releaseControlledIndicator } from '../controlled-indicator.js';

describe('controlled CDP favicon indicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces the cross-navigation script when the control source changes', async () => {
    let scriptIndex = 0;
    const sendCommand = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        scriptIndex += 1;
        return { identifier: `script-${scriptIndex}` };
      }
      return {};
    });
    const session = { client: { sendCommand } } as any;

    await ensureControlledIndicator(session, 'local');
    await ensureControlledIndicator(session, 'remote');
    await ensureControlledIndicator(session, 'remote');

    const addCalls = sendCommand.mock.calls.filter(
      ([method]) => method === 'Page.addScriptToEvaluateOnNewDocument',
    );
    expect(addCalls).toHaveLength(2);
    expect(decodeURIComponent(addCalls[0][1].source)).toContain('data-control-source="local"');
    expect(decodeURIComponent(addCalls[1][1].source)).toContain('data-control-source="remote"');
    expect(addCalls[0][1].source).toContain('state.observer.observe(document');
    expect(sendCommand).toHaveBeenCalledWith('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: 'script-1',
    });
  });

  it('serializes concurrent source changes so every registered script can be released', async () => {
    let scriptIndex = 0;
    const sendCommand = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        scriptIndex += 1;
        return { identifier: `script-${scriptIndex}` };
      }
      return {};
    });
    const session = { client: { sendCommand } } as any;

    await Promise.all([
      ensureControlledIndicator(session, 'local'),
      ensureControlledIndicator(session, 'remote'),
    ]);
    await releaseControlledIndicator(session);

    const removedIdentifiers = sendCommand.mock.calls
      .filter(([method]) => method === 'Page.removeScriptToEvaluateOnNewDocument')
      .map(([, params]) => params.identifier);
    expect(removedIdentifiers).toEqual(['script-1', 'script-2']);
  });
});
