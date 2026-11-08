import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CopyButton } from '../components/CopyButton';
import * as clipboard from '../utils/clipboard';

// Mock clipboard module
vi.mock('../utils/clipboard', () => ({
  copyToClipboard: vi.fn(),
}));

// Mock i18n
vi.mock('../utils/i18n', () => ({
  t: (key: string) => {
    const translations: Record<string, string> = {
      copy: '复制',
    };
    return translations[key] || key;
  },
}));

describe('CopyButton 组件测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应该正确渲染', () => {
    render(<CopyButton text="test text" />);
    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByText('复制')).toBeInTheDocument();
  });

  it('点击后应该调用 copyToClipboard', async () => {
    const copyToClipboardMock = vi.mocked(clipboard.copyToClipboard);
    copyToClipboardMock.mockResolvedValue(true);

    render(<CopyButton text="test text" />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => {
      expect(copyToClipboardMock).toHaveBeenCalledWith('test text');
    });
  });

  it('复制成功后应该显示勾选图标', async () => {
    const copyToClipboardMock = vi.mocked(clipboard.copyToClipboard);
    copyToClipboardMock.mockResolvedValue(true);

    render(<CopyButton text="test text" />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => {
      // 勾选图标出现
      expect(button.querySelector('svg')).toBeInTheDocument();
    });
  });

  it('应该在 2 秒后恢复原始状态', async () => {
    vi.useFakeTimers();

    const copyToClipboardMock = vi.mocked(clipboard.copyToClipboard);
    copyToClipboardMock.mockResolvedValue(true);

    render(<CopyButton text="test text" />);

    const button = screen.getByRole('button');

    // 点击按钮
    fireEvent.click(button);

    // 等待异步操作完成
    await vi.waitFor(
      () => {
        expect(button.querySelector('svg')).toBeInTheDocument();
      },
      { timeout: 100 },
    );

    // 快进 2 秒
    await vi.advanceTimersByTimeAsync(2000);

    // 等待状态更新
    await vi.waitFor(
      () => {
        expect(screen.getByText('复制')).toBeInTheDocument();
      },
      { timeout: 100 },
    );

    vi.useRealTimers();
  }, 10000); // 增加超时时间

  it('应该调用 onCopy 回调', async () => {
    const copyToClipboardMock = vi.mocked(clipboard.copyToClipboard);
    copyToClipboardMock.mockResolvedValue(true);

    const onCopyMock = vi.fn();
    render(<CopyButton text="test text" onCopy={onCopyMock} />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => {
      expect(onCopyMock).toHaveBeenCalled();
    });
  }, 10000);

  it('复制失败时应该输出错误', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const copyToClipboardMock = vi.mocked(clipboard.copyToClipboard);
    copyToClipboardMock.mockResolvedValue(false);

    render(<CopyButton text="test text" />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('复制失败');
    });

    consoleErrorSpy.mockRestore();
  }, 10000);

  it('不应该在复制失败时调用 onCopy 回调', async () => {
    const copyToClipboardMock = vi.mocked(clipboard.copyToClipboard);
    copyToClipboardMock.mockResolvedValue(false);

    const onCopyMock = vi.fn();
    render(<CopyButton text="test text" onCopy={onCopyMock} />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => {
      expect(copyToClipboardMock).toHaveBeenCalled();
    });

    expect(onCopyMock).not.toHaveBeenCalled();
  }, 10000);
});
