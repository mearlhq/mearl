import { describe, expect, it } from 'vitest';
import { resolveActionTimeoutSec, resolveObservedActionTimeoutSec } from '../actionTimeouts.js';

describe('action timeouts', () => {
  it('covers the complete observed page action lifecycle', () => {
    expect(resolveObservedActionTimeoutSec({})).toBe(28);
    expect(
      resolveObservedActionTimeoutSec({
        observe: {
          timeoutMs: 10000,
          navigationGraceMs: 5000,
          navigationTimeoutMs: 30000,
        },
      }),
    ).toBe(54);
  });

  it('keeps action-specific defaults', () => {
    expect(resolveActionTimeoutSec('page_click', {})).toBe(28);
    expect(resolveActionTimeoutSec('page_click', { observe: false })).toBe(15);
    expect(resolveActionTimeoutSec('page_upload', {})).toBe(208);
    expect(resolveActionTimeoutSec('page_upload', { observe: false })).toBe(195);
    expect(resolveActionTimeoutSec('tab_open', {})).toBe(40);
    expect(resolveActionTimeoutSec('set_cookie', {})).toBe(15);
    expect(resolveActionTimeoutSec('set_cookie', { reload: true })).toBe(40);
    expect(resolveActionTimeoutSec('browser_launch', {})).toBe(90);
    expect(resolveActionTimeoutSec('browser_close', {})).toBe(1080);
    expect(resolveActionTimeoutSec('run_actions', { actions: [{}, {}] })).toBe(30);
    expect(
      resolveActionTimeoutSec('run_actions', {
        actions: [
          {
            action: 'send_request',
            data: {
              timeout: 30000,
              files: [{ fieldName: 'file', filePath: '/tmp/image.png' }],
            },
          },
        ],
      }),
    ).toBe(155);
    expect(
      resolveActionTimeoutSec('run_actions', {
        actions: [{ action: 'page_upload', data: { filePaths: ['/tmp/image.png'] } }],
      }),
    ).toBe(208);
    expect(resolveActionTimeoutSec('browser_launch', {}, 120)).toBe(120);
    expect(resolveActionTimeoutSec('send_request', { timeout: 120000 })).toBe(125);
    expect(
      resolveActionTimeoutSec('send_request', {
        timeout: 120000,
        files: [{ fieldName: 'file', filePath: '/tmp/image.png' }],
      }),
    ).toBe(245);
    expect(
      resolveActionTimeoutSec('page_wait', { condition: 'window.ready', timeout: 45000 }),
    ).toBe(50);
    expect(resolveActionTimeoutSec('page_wait', { time: 20000 })).toBe(25);
  });
});
