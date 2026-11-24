import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SpmPickerButton } from '../SpmPickerButton';

it('shows and toggles the SPM picker state', () => {
  const onClick = vi.fn();
  const { rerender } = render(
    <SpmPickerButton active={false} onClick={onClick} title="Pick SPM" />,
  );
  const button = screen.getByRole('button', { name: 'Pick SPM' });
  expect(button).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();

  rerender(<SpmPickerButton active onClick={onClick} title="Pick SPM" />);
  expect(button).toHaveAttribute('aria-pressed', 'true');
});

it('distinguishes a delayed single click from continuous-mode double click', () => {
  vi.useFakeTimers();
  try {
    const onClick = vi.fn();
    const onDoubleClick = vi.fn();
    render(
      <SpmPickerButton
        active
        continuous
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title="Keep picking SPM"
      />,
    );
    const button = screen.getByRole('button', { name: 'Keep picking SPM' });
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(220);
    expect(onClick).toHaveBeenCalledOnce();

    onClick.mockClear();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.doubleClick(button);
    vi.runAllTimers();
    expect(onClick).not.toHaveBeenCalled();
    expect(onDoubleClick).toHaveBeenCalledOnce();
    expect(button).toHaveAttribute('data-continuous', 'true');
  } finally {
    vi.useRealTimers();
  }
});
