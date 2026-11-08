import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchBar } from '../components/detail/SearchBar';
import { createRef } from 'react';

// Mock i18n module
vi.mock('../utils/i18n', () => ({
  t: (key: string) => {
    const translations: Record<string, string> = {
      searchInJson: 'Search in JSON',
    };
    return translations[key] || key;
  },
}));

describe('SearchBar 组件测试', () => {
  const defaultProps = {
    searchQuery: '',
    currentMatchIndex: 0,
    totalMatches: 0,
    onSearchChange: vi.fn(),
    onPrevMatch: vi.fn(),
    onNextMatch: vi.fn(),
    onClose: vi.fn(),
    searchInputRef: createRef<HTMLInputElement>(),
  };

  it('应该正确渲染', () => {
    render(<SearchBar {...defaultProps} />);
    expect(screen.getByPlaceholderText('Search in JSON')).toBeInTheDocument();
  });

  it('应该显示搜索输入框', () => {
    render(<SearchBar {...defaultProps} searchQuery="test" />);
    const input = screen.getByPlaceholderText('Search in JSON') as HTMLInputElement;
    expect(input.value).toBe('test');
  });

  it('输入变化时应该调用 onSearchChange', () => {
    const onSearchChange = vi.fn();
    render(<SearchBar {...defaultProps} onSearchChange={onSearchChange} />);

    const input = screen.getByPlaceholderText('Search in JSON');
    fireEvent.change(input, { target: { value: 'new query' } });

    expect(onSearchChange).toHaveBeenCalledWith('new query');
  });

  it('应该显示匹配计数', () => {
    render(
      <SearchBar {...defaultProps} searchQuery="test" currentMatchIndex={2} totalMatches={5} />,
    );

    expect(screen.getByText('3/5')).toBeInTheDocument();
  });

  it('没有匹配时应该显示 0/0', () => {
    render(
      <SearchBar {...defaultProps} searchQuery="test" currentMatchIndex={0} totalMatches={0} />,
    );

    expect(screen.getByText('0/0')).toBeInTheDocument();
  });

  it('搜索为空时不应该显示匹配计数', () => {
    render(<SearchBar {...defaultProps} searchQuery="" />);

    expect(screen.queryByText(/\d+\/\d+/)).not.toBeInTheDocument();
  });

  it('点击上一个按钮应该调用 onPrevMatch', () => {
    const onPrevMatch = vi.fn();
    render(
      <SearchBar {...defaultProps} searchQuery="test" onPrevMatch={onPrevMatch} totalMatches={5} />,
    );

    const prevButton = screen.getByTitle('prevMatch');
    fireEvent.click(prevButton);

    expect(onPrevMatch).toHaveBeenCalled();
  });

  it('点击下一个按钮应该调用 onNextMatch', () => {
    const onNextMatch = vi.fn();
    render(
      <SearchBar {...defaultProps} searchQuery="test" onNextMatch={onNextMatch} totalMatches={5} />,
    );

    const nextButton = screen.getByTitle('nextMatch');
    fireEvent.click(nextButton);

    expect(onNextMatch).toHaveBeenCalled();
  });

  it('Shift+Enter 应该跳转到上一个匹配项', () => {
    const onPrevMatch = vi.fn();
    const onNextMatch = vi.fn();
    render(
      <SearchBar
        {...defaultProps}
        searchQuery="test"
        onPrevMatch={onPrevMatch}
        onNextMatch={onNextMatch}
        totalMatches={5}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText('Search in JSON'), {
      key: 'Enter',
      shiftKey: true,
    });

    expect(onPrevMatch).toHaveBeenCalledOnce();
    expect(onNextMatch).not.toHaveBeenCalled();
  });

  it('Escape 应该清空搜索词', () => {
    const onSearchChange = vi.fn();
    render(<SearchBar {...defaultProps} searchQuery="test" onSearchChange={onSearchChange} />);

    fireEvent.keyDown(screen.getByPlaceholderText('Search in JSON'), { key: 'Escape' });

    expect(onSearchChange).toHaveBeenCalledWith('');
  });

  it('点击关闭按钮应该调用 onClose', () => {
    const onClose = vi.fn();
    // searchQuery 为空时，X 按钮直接调用 onClose
    render(<SearchBar {...defaultProps} searchQuery="" onClose={onClose} />);

    const closeButton = screen.getByTitle('close');
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalled();
  });

  it('没有匹配时导航按钮应该被禁用', () => {
    render(<SearchBar {...defaultProps} searchQuery="test" totalMatches={0} />);

    const prevButton = screen.getByTitle('prevMatch');
    const nextButton = screen.getByTitle('nextMatch');

    expect(prevButton).toBeDisabled();
    expect(nextButton).toBeDisabled();
  });

  it('有匹配时导航按钮应该被启用', () => {
    render(<SearchBar {...defaultProps} searchQuery="test" totalMatches={5} />);

    const prevButton = screen.getByTitle('prevMatch');
    const nextButton = screen.getByTitle('nextMatch');

    expect(prevButton).not.toBeDisabled();
    expect(nextButton).not.toBeDisabled();
  });
});
