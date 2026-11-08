import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wrench } from 'lucide-react';
import { ToolSwitcher } from '../ToolSwitcher';

vi.mock('../../../panel/utils/i18n', () => ({ t: (key: string) => key }));

describe('ToolSwitcher', () => {
  afterEach(() => vi.useRealTimers());
  const tools = () => [
    { id: 'one', title: 'One', icon: Wrench, onClick: vi.fn() },
    { id: 'two', title: 'Two', icon: Wrench, onClick: vi.fn() },
  ];

  it('opens after 200ms of hover without moving focus and allows crossing the menu gap', () => {
    vi.useFakeTimers();
    render(<ToolSwitcher currentId="one" tools={tools()} />);
    const trigger = screen.getByRole('button', { name: 'toolboxSwitchTool' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(199));
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseLeave(trigger.parentElement!);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.mouseEnter(screen.getByRole('menu'));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseLeave(trigger.parentElement!);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('cancels short hover and clears the pending timer on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = render(<ToolSwitcher currentId="one" tools={tools()} />);
    const trigger = screen.getByRole('button', { name: 'toolboxSwitchTool' });
    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.mouseEnter(trigger);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a keyboard-focused menu open on mouse leave and dismisses on focus leaving', () => {
    vi.useFakeTimers();
    render(<ToolSwitcher currentId="one" tools={tools()} />);
    const trigger = screen.getByRole('button', { name: 'toolboxSwitchTool' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.mouseLeave(trigger.parentElement!);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('menuitemradio', { name: 'One' })).toHaveFocus();
    fireEvent.blur(screen.getByRole('menuitemradio', { name: 'One' }), {
      relatedTarget: document.body,
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('preserves supplied order, marks the current tool and skips reopening it', () => {
    const rows = tools();
    render(<ToolSwitcher currentId="two" tools={rows} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([
      'One',
      'Two',
    ]);
    expect(screen.getByRole('menuitemradio', { name: 'Two' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Two' }));
    expect(rows[1].onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'One' }));
    expect(rows[0].onClick).toHaveBeenCalledExactlyOnceWith();
  });

  it('supports keyboard navigation and closes with Escape without bubbling', () => {
    const parentKeyDown = vi.fn();
    render(
      <div onKeyDown={parentKeyDown}>
        <ToolSwitcher currentId="two" tools={tools()} />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'toolboxSwitchTool' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const one = screen.getByRole('menuitemradio', { name: 'One' });
    const two = screen.getByRole('menuitemradio', { name: 'Two' });
    expect(two).toHaveFocus();
    fireEvent.keyDown(two, { key: 'ArrowDown' });
    expect(one).toHaveFocus();
    fireEvent.keyDown(one, { key: 'End' });
    expect(two).toHaveFocus();
    parentKeyDown.mockClear();
    fireEvent.keyDown(two, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('opens and focuses the selected tool with keyboard %j', key => {
    render(<ToolSwitcher currentId="two" tools={tools()} />);
    const trigger = screen.getByRole('button', { name: 'toolboxSwitchTool' });
    fireEvent.keyDown(trigger, { key });
    expect(screen.getByRole('menuitemradio', { name: 'Two' })).toHaveFocus();
    trigger.focus();
    fireEvent.keyDown(trigger, { key });
    expect(screen.getByRole('menuitemradio', { name: 'Two' })).toHaveFocus();
  });

  it('dismisses when clicking outside', () => {
    render(<ToolSwitcher currentId="one" tools={tools()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'toolboxSwitchTool' }), {
      key: 'ArrowDown',
    });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('returns focus to the trigger before leaving the menu with Tab', () => {
    render(<ToolSwitcher currentId="one" tools={tools()} />);
    const trigger = screen.getByRole('button', { name: 'toolboxSwitchTool' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'One' }), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
