import { describe, expect, it, vi } from 'vitest';
import { runActionBatch } from '../runActions.js';
import { PageActionDispatchUncertainError } from '../pageAct.js';

describe('shared action batches', () => {
  it('stops at unsupported host actions after preserving completed steps', async () => {
    const execute = vi.fn(async () => ({ success: true, data: { clicked: true } }));
    const result = await runActionBatch(
      {
        tabId: 7,
        actions: [
          { action: 'page_click' },
          { action: 'agent_chat_run' as any },
          { action: 'page_type' },
        ],
      },
      execute,
    );
    expect(result).toMatchObject({
      completedSteps: 1,
      failedStep: 1,
      totalSteps: 3,
      error: expect.stringContaining('unsupported'),
      results: [{ step: 0, success: true }],
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith('page_click', { tabId: 7 });
  });

  it('preserves uncertain dispatch evidence and includes the failed step', async () => {
    const result = await runActionBatch(
      { tabId: 7, actions: [{ action: 'page_click' }] },
      async () => {
        throw new PageActionDispatchUncertainError('click may have been sent', {
          attempt: { sent: true },
        });
      },
    );
    expect(result).toMatchObject({
      completedSteps: 0,
      failedStep: 0,
      stage: 'dispatch-uncertain',
      attempt: { sent: true },
      results: [
        { step: 0, success: false, error: 'click may have been sent', stage: 'dispatch-uncertain' },
      ],
    });
  });

  it('rejects private actions while dispatching file requests as ordinary send_request steps', async () => {
    const execute = vi.fn(async () => ({ success: true, data: {} }));
    const data = {
      tabId: 7,
      actions: [{ action: '__send_request_files' as any, data: { url: 'https://example.com' } }],
    };
    expect(await runActionBatch(data, execute)).toMatchObject({
      failedStep: 0,
      error: expect.stringContaining('internal action'),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(
      await runActionBatch(
        { ...data, actions: [{ action: 'send_request', data: { url: 'https://example.com' } }] },
        execute,
      ),
    ).toMatchObject({
      completedSteps: 1,
      results: [{ action: 'send_request', success: true }],
    });
  });

  it('validates targets and runs the control check before dispatching each step', async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const beforeStep = vi.fn(() => {
      throw new Error('paused');
    });
    expect(
      await runActionBatch({ tabId: 7, actions: [{ action: 'page_click' }] }, execute, {
        beforeStep,
      }),
    ).toMatchObject({ failedStep: 0, error: 'paused', results: [{ success: false }] });
    expect(execute).not.toHaveBeenCalled();
    expect(
      await runActionBatch(
        { tabId: 7, actions: [{ action: 'page_click', data: { tabId: null as any } }] },
        execute,
      ),
    ).toMatchObject({ failedStep: 0, error: expect.stringContaining('numeric tabId') });
  });
});

it('keeps browser capability discovery outside tab-scoped batches', async () => {
  const execute = vi.fn();
  const result = await runActionBatch({ tabId: 7, actions: [{ action: 'get_capabilities' as any }] }, execute);
  expect(result.failedStep).toBe(0);
  expect(result.error).toContain('browser-level action');
  expect(execute).not.toHaveBeenCalled();
});
