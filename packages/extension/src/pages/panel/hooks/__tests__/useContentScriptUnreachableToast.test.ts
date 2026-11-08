import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPageHostPermissionGranted,
  showHostPermissionPromptIfNeeded,
} from '../useContentScriptUnreachableToast';

const toastMocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('../../utils/toast', () => ({
  showToast: toastMocks.showToast,
}));

vi.mock('../../utils/i18n', () => ({
  t: (key: string) => key,
}));

describe('showHostPermissionPromptIfNeeded', () => {
  beforeEach(() => {
    toastMocks.showToast.mockReset();
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({ id: 7, url: 'https://www.example.com/page' }),
      reload: vi.fn().mockResolvedValue(undefined),
    } as any;
    chrome.permissions = {
      contains: vi.fn((_permissions, callback) => callback(false)),
      request: vi.fn((_permissions, callback) => callback(true)),
    } as any;
  });

  it('uses the existing permission toast and native permission request', async () => {
    await expect(showHostPermissionPromptIfNeeded(7)).resolves.toBe(true);

    expect(toastMocks.showToast).toHaveBeenCalledWith(
      'contentScriptNeedsPermission',
      'error',
      8000,
      expect.objectContaining({ label: 'hostPermissionGrant' }),
    );

    const permissionAction = toastMocks.showToast.mock.calls[0]?.[3];
    permissionAction?.onClick();
    expect(chrome.permissions.request).toHaveBeenCalledWith(
      { origins: ['*://*.example.com/*'] },
      expect.any(Function),
    );
    expect(toastMocks.showToast).toHaveBeenLastCalledWith('hostPermissionGranted', 'success');
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  it('does not prompt when the current origin is already authorized', async () => {
    chrome.permissions = {
      ...chrome.permissions,
      contains: vi.fn(
        (_permissions: chrome.permissions.Permissions, callback: (granted: boolean) => void) =>
          callback(true),
      ),
    } as any;

    await expect(showHostPermissionPromptIfNeeded(7)).resolves.toBe(false);
    expect(toastMocks.showToast).not.toHaveBeenCalled();
  });

  it('returns the current page authorization state for settings UI', async () => {
    await expect(getPageHostPermissionGranted(7)).resolves.toBe(false);
    expect(chrome.permissions.contains).toHaveBeenCalledWith(
      { origins: ['https://www.example.com/*'] },
      expect.any(Function),
    );
  });

  it('falls back to the inspected page when Tabs hides an unauthorized URL', async () => {
    chrome.tabs.get = vi.fn().mockResolvedValue({ id: 7 });
    chrome.devtools.inspectedWindow.eval = vi.fn((_expression, callback) => {
      callback({ origin: 'https://www.example.com', hostname: 'www.example.com' }, undefined);
    });

    await expect(showHostPermissionPromptIfNeeded(7)).resolves.toBe(true);
    expect(toastMocks.showToast).toHaveBeenCalledWith(
      'contentScriptNeedsPermission',
      'error',
      8000,
      expect.objectContaining({ label: 'hostPermissionGrant' }),
    );
  });
});
