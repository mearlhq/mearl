import { describe, expect, it } from 'vitest';
import type { AgentChatEvent } from '@mearl/browser-core';
import { isMearlCommandApproval } from '../approvalPolicy';

function approval(
  params: Record<string, unknown>,
  method = 'item/commandExecution/requestApproval',
): AgentChatEvent {
  return {
    id: 'approval_1',
    sessionId: 'session_1',
    providerId: 'codex',
    kind: 'request',
    method,
    params,
    requestId: 1,
    timestamp: 1,
  };
}

describe('isMearlCommandApproval', () => {
  it('recognizes current Codex mearl approvals from the structured exec-policy prefix', () => {
    expect(
      isMearlCommandApproval(
        approval({
          command: `/bin/zsh -lc "mearl page_snapshot --payload '{"tabId":11}'"`,
          commandActions: [{ type: 'unknown', command: 'mearl page_snapshot' }],
          proposedExecpolicyAmendment: ['mearl', 'page_snapshot', '--payload'],
          additionalPermissions: { network: null, fileSystem: null },
          proposedNetworkPolicyAmendments: [],
        }),
      ),
    ).toBe(true);
  });

  it('recognizes direct and legacy argv mearl commands', () => {
    expect(isMearlCommandApproval(approval({ command: 'mearl page_snapshot --tab-id 11' }))).toBe(
      true,
    );
    expect(
      isMearlCommandApproval(
        approval({ command: ['mearl', 'page_snapshot', '--tab-id', '11'] }, 'execCommandApproval'),
      ),
    ).toBe(true);
  });

  it('does not match commands that merely contain the mearl name', () => {
    expect(isMearlCommandApproval(approval({ command: 'echo mearl' }))).toBe(false);
    expect(isMearlCommandApproval(approval({ command: 'mearl-helper page_snapshot' }))).toBe(false);
  });

  it('keeps compound commands and additional permissions behind approval', () => {
    expect(
      isMearlCommandApproval(approval({ command: 'mearl page_snapshot && rm -rf /tmp/x' })),
    ).toBe(false);
    expect(
      isMearlCommandApproval(approval({ command: 'mearl page_snapshot "$(touch /tmp/x)"' })),
    ).toBe(false);
    expect(
      isMearlCommandApproval(
        approval({
          command: 'mearl page_snapshot',
          proposedExecpolicyAmendment: ['mearl', 'page_snapshot'],
          commandActions: [
            { type: 'unknown', command: 'mearl page_snapshot' },
            { type: 'unknown', command: 'rm -rf /tmp/x' },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isMearlCommandApproval(
        approval({
          command: 'mearl page_snapshot',
          proposedExecpolicyAmendment: ['mearl', 'page_snapshot'],
          additionalPermissions: { network: { enabled: true } },
        }),
      ),
    ).toBe(false);
  });

  it('requires structured command evidence to agree with the mearl exec-policy prefix', () => {
    expect(
      isMearlCommandApproval(
        approval({
          command: 'rm -rf /tmp/x',
          proposedExecpolicyAmendment: ['mearl', 'page_snapshot'],
        }),
      ),
    ).toBe(false);
    expect(
      isMearlCommandApproval(
        approval({
          command: '/bin/zsh -lc "rm -rf /tmp/x"',
          commandActions: [{ type: 'unknown', command: 'rm -rf /tmp/x' }],
          proposedExecpolicyAmendment: ['mearl', 'page_snapshot'],
        }),
      ),
    ).toBe(false);
    expect(
      isMearlCommandApproval(
        approval({
          command: '/bin/zsh -lc "mearl page_snapshot $(touch /tmp/x)"',
          commandActions: [{ type: 'unknown', command: 'mearl page_snapshot' }],
          proposedExecpolicyAmendment: ['mearl', 'page_snapshot'],
        }),
      ),
    ).toBe(false);
  });

  it('does not treat other approval types as mearl commands', () => {
    expect(
      isMearlCommandApproval(
        approval({ changes: [{ path: 'src/app.ts' }] }, 'item/fileChange/requestApproval'),
      ),
    ).toBe(false);
  });
});
