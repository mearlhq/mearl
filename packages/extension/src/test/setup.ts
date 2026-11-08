import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    i18n: {
      getMessage: (key: string) => key,
      getUILanguage: () => 'zh_CN',
    },
    runtime: {
      getURL: (path: string) => path,
    },
  },
}));

// 在每个测试后清理
afterEach(() => {
  cleanup();
});

// Mock Chrome API
global.chrome = {
  runtime: {
    sendMessage: vi.fn(),
    getManifest: vi.fn(() => ({ version: '2.0.0' })),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    lastError: undefined,
  } as any,
  devtools: {
    network: {
      onRequestFinished: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    } as any,
    inspectedWindow: {
      tabId: 1,
      onNavigated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    } as any,
  } as any,
  debugger: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    onEvent: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  } as any,
  // 导航等待（waitForTabLoad）靠这些事件判定新文档是否已提交，
  // 默认空实现：不派发任何导航事件，等于「本次调用未产生导航」
  webNavigation: {
    onBeforeNavigate: { addListener: vi.fn(), removeListener: vi.fn() },
    onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
    onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onReferenceFragmentUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  } as any,
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  } as any,
} as any;

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
