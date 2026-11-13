import { describe, expect, it } from 'vitest';
import { isAgentActionAllowedByInternalBoundary } from '../agentMessageTrust';

describe('agent internal action boundary', () => {
  it('rejects direct internal actions', () => {
    expect(isAgentActionAllowedByInternalBoundary('__export_cookies')).toBe(false);
  });

  it('allows native-host trusted internal actions and normal agent actions', () => {
    expect(isAgentActionAllowedByInternalBoundary('__export_cookies', true)).toBe(true);
    expect(isAgentActionAllowedByInternalBoundary('__toolbox_open')).toBe(true);
    expect(isAgentActionAllowedByInternalBoundary('browser_manage')).toBe(true);
  });
});
