import { ExtensionRpcError } from '@mearl/browser-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestToolbox, toolboxNativeHostUpdateInfo } from '../toolboxRequest';

vi.mock('../../panel/utils/i18n', () => ({ t: (key: string) => key }));

describe('toolbox requests', () => {
  beforeEach(() => {
    vi.mocked(chrome.runtime.sendMessage).mockReset();
  });

  it.each(['PROTOCOL_MISMATCH', 'UNSUPPORTED_ACTION'] as const)(
    'shows an update instruction for %s without retrying',
    async code => {
      const message = 'Service unsupported';
      vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
        success: false,
        code,
        error: message,
      });
      let error: unknown;
      try {
        await requestToolbox('toolbox_task', { operation: 'list', id: 'plugin:example' });
      } catch (cause) {
        error = cause;
      }
      expect(error).toEqual(
        new ExtensionRpcError(
          code,
          code === 'PROTOCOL_MISMATCH' ? 'nativeHostProtocolMismatch' : message,
        ),
      );
      expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
        action: 'toolbox_task',
        data: { operation: 'list', id: 'plugin:example' },
      });

      vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
        success: true,
        status: { connected: true, extensionVersion: '2.21.0', nativeHostVersion: '2.20.0' },
      });
      expect(await toolboxNativeHostUpdateInfo(error)).toEqual({
        reason: 'unsupported-capability',
        extensionVersion: '2.21.0',
        nativeHostVersion: '2.20.0',
      });
    },
  );

  it('preserves ordinary operation errors', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      success: false,
      error: 'Task not found',
    });
    await expect(
      requestToolbox('toolbox_task', {
        operation: 'get',
        id: 'plugin:example',
        taskId: 'task-one',
      }),
    ).rejects.toThrow('Task not found');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('returns successful task replies', async () => {
    const result = { tasks: [] };
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true, data: result });
    await expect(
      requestToolbox('toolbox_task', {
        operation: 'list',
        id: 'plugin:example',
      }),
    ).resolves.toEqual(result);
  });
});
