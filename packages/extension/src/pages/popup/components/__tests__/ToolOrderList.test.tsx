import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolOrderList } from '../ToolOrderList';

vi.mock('../../../panel/utils/i18n', () => ({ t: (key: string) => key }));

const tools = ['a', 'b', 'c', 'd'].map(id => ({ id, title: id.toUpperCase() }));
const dataTransfer = () => ({ effectAllowed: '', dropEffect: '', setData: vi.fn() });
function dragOver(element: Element, transfer: ReturnType<typeof dataTransfer>, clientY: number) {
  const event = new Event('dragover', { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: transfer, clientY });
  fireEvent(element, event);
}

function setup() {
  const onOrderChange = vi.fn();
  const onPinnedCountChange = vi.fn();
  const { container } = render(
    <ToolOrderList
      tools={tools}
      pinnedCount={2}
      onOrderChange={onOrderChange}
      onPinnedCountChange={onPinnedCountChange}
    />,
  );
  const row = (id: string) => container.querySelector(`[data-tool-id="${id}"]`)!;
  tools.forEach(({ id }) => {
    vi.spyOn(row(id), 'getBoundingClientRect').mockReturnValue({ top: 10, height: 40 } as DOMRect);
  });
  return { container, row, onOrderChange, onPinnedCountChange };
}

describe('ToolOrderList', () => {
  it('commits a fast drop before the drag preview has rendered', () => {
    const { row, onOrderChange } = setup();
    const transfer = dataTransfer();
    act(() => {
      fireEvent.dragStart(row('a'), { dataTransfer: transfer });
      dragOver(row('c'), transfer, 49);
      fireEvent.drop(row('c'), { dataTransfer: transfer });
      fireEvent.dragEnd(row('a'));
    });
    expect(onOrderChange).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a', 'd']);
  });

  it.each([
    ['a', 'c', 11, ['b', 'a', 'c', 'd']],
    ['a', 'c', 49, ['b', 'c', 'a', 'd']],
    ['d', 'a', 11, ['d', 'a', 'b', 'c']],
  ])('previews and inserts %s at the selected half of %s', (from, to, clientY, expected) => {
    const { container, row, onOrderChange, onPinnedCountChange } = setup();
    const transfer = dataTransfer();
    fireEvent.dragStart(row(from as string), { dataTransfer: transfer });
    dragOver(row(to as string), transfer, clientY);
    expect(container.querySelector('[data-tool-drop-indicator]')).toBeInTheDocument();
    fireEvent.drop(row(to as string), { dataTransfer: transfer, clientY });
    expect(onOrderChange).toHaveBeenCalledExactlyOnceWith(expected);
    expect(onPinnedCountChange).not.toHaveBeenCalled();
    expect(container.querySelector('[data-tool-drop-indicator]')).toBeNull();
  });

  it('clears the preview on cancellation and ignores external drags and adjacent drops', () => {
    const { container, row, onOrderChange } = setup();
    const transfer = dataTransfer();
    dragOver(row('c'), transfer, 49);
    expect(container.querySelector('[data-tool-drop-indicator]')).toBeNull();
    fireEvent.dragStart(row('a'), { dataTransfer: transfer });
    dragOver(row('b'), transfer, 11);
    expect(container.querySelector('[data-tool-drop-indicator]')).toBeNull();
    fireEvent.drop(row('b'), { dataTransfer: transfer });
    expect(onOrderChange).not.toHaveBeenCalled();
    fireEvent.dragStart(row('a'), { dataTransfer: transfer });
    dragOver(row('c'), transfer, 49);
    fireEvent.dragEnd(row('a'));
    expect(container.querySelector('[data-tool-drop-indicator]')).toBeNull();
    expect(onOrderChange).not.toHaveBeenCalled();
  });

  it.each([
    [11, 0],
    [49, 1],
  ])('moves the divider to a tool boundary', (clientY, expected) => {
    const { container, row, onPinnedCountChange, onOrderChange } = setup();
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole('separator'), { dataTransfer: transfer });
    dragOver(row('a'), transfer, clientY);
    expect(container.querySelector('[data-tool-drop-indicator]')).toBeInTheDocument();
    fireEvent.drop(row('a'), { dataTransfer: transfer });
    expect(onPinnedCountChange).toHaveBeenCalledExactlyOnceWith(expected);
    expect(onOrderChange).not.toHaveBeenCalled();
  });

  it.each(['tool', 'divider'])('drops the %s at the final row boundary', dragged => {
    const { row, onOrderChange, onPinnedCountChange } = setup();
    const transfer = dataTransfer();
    fireEvent.dragStart(dragged === 'tool' ? row('a') : screen.getByRole('separator'), {
      dataTransfer: transfer,
    });
    dragOver(row('d'), transfer, 49);
    fireEvent.drop(row('d'), { dataTransfer: transfer });
    if (dragged === 'tool') {
      expect(onOrderChange).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'd', 'a']);
    } else {
      expect(onPinnedCountChange).toHaveBeenCalledExactlyOnceWith(4);
    }
  });

  it('supports pinning every tool and adjusting the divider with the keyboard', () => {
    function ControlledList() {
      const [count, setCount] = useState(2);
      return (
        <ToolOrderList
          tools={tools}
          pinnedCount={count}
          onOrderChange={vi.fn()}
          onPinnedCountChange={setCount}
        />
      );
    }
    render(<ControlledList />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '4');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' });
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '4');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Home' });
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '0');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' });
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '0');
  });
});
