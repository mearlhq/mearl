import { describe, expect, it } from 'vitest';
import { buildPageWaitExpression, resolvePageWaitInput } from '../pageWait';

describe('page wait input', () => {
  it('normalizes the time wait', () => {
    expect(resolvePageWaitInput({ time: 120 })).toMatchObject({ mode: 'time', time: 120 });
  });

  it('normalizes selector and condition polling', () => {
    expect(
      resolvePageWaitInput({ selector: ' .ready ', state: 'visible', interval: 10 }),
    ).toMatchObject({
      mode: 'selector',
      selector: '.ready',
      state: 'visible',
      interval: 50,
    });
    expect(resolvePageWaitInput({ condition: ' window.ready ', timeout: 45000 })).toMatchObject({
      mode: 'condition',
      condition: 'window.ready',
      timeout: 45000,
    });
  });

  it('supports visible text polling with optional exact matching', () => {
    expect(resolvePageWaitInput({ text: ' 提交成功 ', exact: true })).toMatchObject({
      mode: 'text',
      text: '提交成功',
      exact: true,
    });
    expect(buildPageWaitExpression(resolvePageWaitInput({ text: '提交成功' }))).toContain(
      '.includes(expected)',
    );
  });

  it('requires exactly one wait mode', () => {
    expect(() => resolvePageWaitInput({})).toThrow('exactly one');
    expect(() => resolvePageWaitInput({ time: 1, selector: '.ready' })).toThrow('exactly one');
    expect(() => resolvePageWaitInput({ time: 1, state: 'hidden' })).toThrow(
      'only supported with "selector"',
    );
  });
});
