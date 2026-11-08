import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolHost } from '../ToolHost';

const mocks = vi.hoisted(() => ({
  requestToolbox: vi.fn(),
  getCurrentLanguage: vi.fn(() => 'zh_CN'),
  initI18n: vi.fn(async () => {}),
  onConfigChange: vi.fn((_listener: (changes: { language?: string }) => void) => vi.fn()),
}));

vi.mock('../../popup/toolboxRequest', () => ({ requestToolbox: mocks.requestToolbox }));
vi.mock('../../panel/utils/i18n', () => ({
  getCurrentLanguage: mocks.getCurrentLanguage,
  initI18n: mocks.initI18n,
  t: (key: string) => key,
}));
vi.mock('../../panel/utils/config', () => ({ onConfigChange: mocks.onConfigChange }));
vi.mock('../SandboxToolPage', () => ({
  SandboxToolPage: ({ title }: { title: string }) => <iframe title={title} />,
}));

describe('ToolHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentLanguage.mockReturnValue('zh_CN');
    window.history.replaceState({}, '', '#notebook');
    document.title = 'Mearl';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the localized registered sandbox page and updates the tab title', async () => {
    mocks.requestToolbox.mockResolvedValue({
      title: 'Workspace Notes',
      locales: { zh_CN: { title: '工作区笔记' } },
      page: { type: 'sandbox', hash: 'a'.repeat(64), size: 128, chunks: 1 },
    });

    render(<ToolHost />);

    expect(await screen.findByTitle('工作区笔记')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('工作区笔记 - Mearl'));
    expect(mocks.requestToolbox).toHaveBeenCalledWith('toolbox_tool_open', {
      id: 'plugin:notebook',
    });
  });

  it('rejects a popup-only tool opened directly in a tab', async () => {
    mocks.requestToolbox.mockResolvedValue({
      title: 'Overlay',
      displayMode: 'popup',
      page: { type: 'sandbox', hash: 'a'.repeat(64), size: 128, chunks: 1 },
    });
    render(<ToolHost />);
    expect(await screen.findByText('toolboxPopupOnly')).toBeInTheDocument();
    expect(screen.queryByTitle('Overlay')).not.toBeInTheDocument();
  });

  it('updates an open tool and its title when the language preference changes', async () => {
    let notify: (changes: { language?: string }) => void = () => {};
    const unsubscribe = vi.fn();
    mocks.onConfigChange.mockImplementationOnce(listener => {
      notify = listener;
      return unsubscribe;
    });
    mocks.requestToolbox.mockResolvedValue({
      title: 'Workspace Notes',
      locales: { zh_CN: { title: '工作区笔记' } },
      page: { type: 'sandbox', hash: 'a'.repeat(64), size: 128, chunks: 1 },
    });
    const { unmount } = render(<ToolHost />);
    const frame = await screen.findByTitle('工作区笔记');
    await act(async () => {
      mocks.getCurrentLanguage.mockReturnValue('en');
      notify({ language: 'en' });
    });
    expect(mocks.initI18n).toHaveBeenCalledWith('en');
    expect(screen.getByTitle('Workspace Notes')).toBe(frame);
    expect(document.title).toBe('Workspace Notes - Mearl');
    expect(mocks.requestToolbox).toHaveBeenCalledOnce();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('hides the opening indicator for fast requests and cancels its timer', async () => {
    vi.useFakeTimers();
    mocks.requestToolbox.mockResolvedValue({
      title: 'Workspace Notes',
      page: { type: 'sandbox', hash: 'a'.repeat(64), size: 128, chunks: 1 },
    });
    render(<ToolHost />);
    expect(screen.queryByText('toolboxToolOpening')).not.toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByTitle('Workspace Notes')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByText('toolboxToolOpening')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the opening indicator after 300 ms and removes it when ready', async () => {
    vi.useFakeTimers();
    let resolveOpen: (value: unknown) => void = () => {};
    mocks.requestToolbox.mockReturnValue(
      new Promise(resolve => {
        resolveOpen = resolve;
      }),
    );
    render(<ToolHost />);
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status')).toHaveTextContent('toolboxToolOpening');
    await act(async () => {
      resolveOpen({
        title: 'Workspace Notes',
        page: { type: 'sandbox', hash: 'a'.repeat(64), size: 128, chunks: 1 },
      });
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByTitle('Workspace Notes')).toBeInTheDocument();
  });

  it('cancels the delayed indicator when unmounted', () => {
    vi.useFakeTimers();
    mocks.requestToolbox.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<ToolHost />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
