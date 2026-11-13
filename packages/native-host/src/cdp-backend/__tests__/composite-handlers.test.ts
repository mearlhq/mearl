import { describe, expect, it } from 'vitest';
import { cdpRunActions } from '../composite-handlers';

describe('native CDP composite handlers', () => {
  it('rejects run_actions nesting consistently with the extension path', async () => {
    await expect(
      cdpRunActions({} as any, {
        tabId: 7,
        actions: [{ action: 'run_actions', data: { actions: [] } }],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        completedSteps: 0,
        failedStep: 0,
        error: 'Step 0: composite action "run_actions" is not allowed in run_actions',
      }),
    );
  });

  it('rejects browser_manage inside a composite action', async () => {
    await expect(
      cdpRunActions({} as any, {
        tabId: 7,
        actions: [{ action: 'browser_manage', data: { operation: 'release' } } as any],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        completedSteps: 0,
        failedStep: 0,
        error: 'Step 0: unsupported action "browser_manage"',
      }),
    );
  });

  it('rejects a step that overrides the shared tab with an invalid target', async () => {
    await expect(
      cdpRunActions({} as any, {
        tabId: 7,
        actions: [{ action: 'get_logs', data: { tabId: null } }],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        completedSteps: 0,
        failedStep: 0,
        error: expect.stringContaining('get_logs requires a numeric tabId'),
      }),
    );
  });
});
