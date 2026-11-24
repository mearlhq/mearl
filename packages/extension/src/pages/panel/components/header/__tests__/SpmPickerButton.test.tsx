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
