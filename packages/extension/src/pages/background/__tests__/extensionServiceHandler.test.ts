import { describe, it, expect, vi } from 'vitest';
import { ExtensionRpcError } from '@mearl/browser-core';
import { handleExtensionServiceRequest } from '../extensionServiceHandler';
vi.mock('../../panel/utils/i18n', () => ({ t: (key: string) => key }));
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const ui = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` };

describe('extension service boundary', () => {
  it.each([
    'browser_sessions',
    'browser_instances',
    'browser_providers',
    'browser_manage',
    'agent_chat_start',
    'agent_skills_install',
    'start_cloud_connector',
    'toolbox_task',
  ])('rejects content scripts before opening the host for %s', async action => {
    const request = vi.fn();
    const result = await handleExtensionServiceRequest(
      { action },
      { id: extensionId, url: 'https://example.test' },
      { extensionId, ready: Promise.resolve(), request },
    );
    expect(result).toMatchObject({ success: false, code: 'EXTENSION_UI_REQUIRED' });
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps business errors inside successful data and preserves long operation budgets', async () => {
    const result = { error: { code: 'PLUGIN_QUEUE_FULL', message: 'busy' } };
    const request = vi.fn().mockResolvedValue(result);
    const data = { operation: 'launch_form', provider: 'demo', values: {} };
    expect(
      await handleExtensionServiceRequest({ action: 'browser_providers', data }, ui, {
        extensionId,
        ready: Promise.resolve(),
        request,
      }),
    ).toEqual({ success: true, data: result });
    expect(request).toHaveBeenCalledExactlyOnceWith('browser_providers', data, 120000);
  });
  it('rejects arbitrary browser actions outside the UI service allowlist', async () => {
    const request = vi.fn();
    expect(
      await handleExtensionServiceRequest({ action: 'page_eval' }, ui, {
        extensionId,
        ready: Promise.resolve(),
        request,
      }),
    ).toMatchObject({ success: false, code: 'UNSUPPORTED_ACTION' });
    expect(request).not.toHaveBeenCalled();
  });
  it('propagates structured transport errors without replaying requests', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new ExtensionRpcError('PROTOCOL_MISMATCH', 'Update required'));
    expect(
      await handleExtensionServiceRequest(
        { action: 'browser_sessions', data: { operation: 'list' } },
        ui,
        { extensionId, ready: Promise.resolve(), request },
      ),
    ).toEqual({ success: false, code: 'PROTOCOL_MISMATCH', error: 'Update required' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
