import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InjectedAppProfileConfig } from '@mearl/browser-core';
import { updateAppProfileActionIcon } from '../appProfileActionIcon';

function sampleConfig(profile: string): InjectedAppProfileConfig {
  return {
    profile,
    label: profile,
    globals: {},
    bridges: [],
    activeEvents: [],
    maxTouchPoints: 5,
    statusBarHeight: 59,
    language: 'zh-Hans',
    userAgent: '',
    navigatorPlatform: 'iPhone',
    platform: 'iOS',
    systemVersion: '17.5',
    clientType: 'iphone',
    actions: { open: [], close: [], title: [], systemInfo: [], protocol: [], noop: [] },
    schemes: [],
  };
}

const setIcon = vi.fn((_: unknown, callback?: () => void) => callback?.());
const setBadgeText = vi.fn((_: unknown, callback?: () => void) => callback?.());
const setBadgeBackgroundColor = vi.fn();
afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.clearAllMocks();
  (global.chrome as unknown as Record<string, unknown>).action = {
    setIcon,
    setBadgeText,
    setBadgeBackgroundColor,
  };
});

describe('updateAppProfileActionIcon', () => {
  it('renders an accepted capability icon at toolbar size and releases its bitmap', async () => {
    const bitmap = { close: vi.fn() };
    const imageData = { width: 32, height: 32 };
    const context = { drawImage: vi.fn(), getImageData: vi.fn(() => imageData) };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return context; } });
    const config = sampleConfig('sample');
    config.binding = { definition: { actionIcon: 'data:image/png;base64,iVBORw0KGgo=' } } as InjectedAppProfileConfig['binding'];
    await updateAppProfileActionIcon(7, config);
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 32, 32);
    expect(setIcon).toHaveBeenCalledWith({ tabId: 7, imageData }, expect.any(Function));
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it.each([['reader'], ['shop'], ['wallet'], ['chat']])(
    '为 %s 使用 32px favicon 合成图标',
    async profile => {
      await updateAppProfileActionIcon(7, sampleConfig(profile));

      expect(setIcon).toHaveBeenCalledWith(
        {
          tabId: 7,
          path: 'icons/app-profiles/generic-32.png',
        },
        expect.any(Function),
      );
      expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' }, expect.any(Function));
      expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
    },
  );

  it('其他 App 档案使用通用状态图标', async () => {
    await updateAppProfileActionIcon(8, sampleConfig('sample'));

    expect(setIcon).toHaveBeenCalledWith(
      {
        tabId: 8,
        path: 'icons/app-profiles/generic-32.png',
      },
      expect.any(Function),
    );
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 8, text: '' }, expect.any(Function));
    expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it('取消模拟后恢复默认图标并清空 badge', async () => {
    await updateAppProfileActionIcon(9);

    expect(setIcon).toHaveBeenCalledWith(
      {
        tabId: 9,
        path: 'icons/icon-32x32.png',
      },
      expect.any(Function),
    );
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 9, text: '' }, expect.any(Function));
    expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it('同步消费 tab 关闭产生的 runtime.lastError', async () => {
    setIcon.mockImplementationOnce((_, callback) => {
      chrome.runtime.lastError = { message: 'No tab with id: 9.' };
      callback?.();
      chrome.runtime.lastError = undefined;
    });

    await expect(updateAppProfileActionIcon(9)).rejects.toThrow('No tab with id: 9.');
    expect(setBadgeText).not.toHaveBeenCalled();
  });
});
