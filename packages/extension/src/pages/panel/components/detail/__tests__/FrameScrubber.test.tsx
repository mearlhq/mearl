import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FrameScrubber } from '../FrameScrubber';

const getInput = () => screen.getByRole('textbox') as HTMLInputElement;

describe('FrameScrubber', () => {
  it('展示当前帧数', () => {
    render(<FrameScrubber value={5} total={20} onChange={() => {}} />);
    expect(getInput().value).toBe('5');
  });

  it('输入数字实时上报，并 clamp 到 [1, total]', () => {
    const onChange = vi.fn();
    render(<FrameScrubber value={5} total={20} onChange={onChange} />);
    const input = getInput();
    fireEvent.change(input, { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith(12);
    fireEvent.change(input, { target: { value: '999' } });
    expect(onChange).toHaveBeenLastCalledWith(20); // 超出上限被 clamp
  });

  it('非数字字符被过滤', () => {
    const onChange = vi.fn();
    render(<FrameScrubber value={5} total={20} onChange={onChange} />);
    fireEvent.change(getInput(), { target: { value: '1a3' } });
    expect(onChange).toHaveBeenLastCalledWith(13);
  });

  it('↑↓ 键 ±1、Shift+↑↓ ±10，并 clamp', () => {
    const onChange = vi.fn();
    render(<FrameScrubber value={5} total={20} onChange={onChange} />);
    const input = getInput();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(6);
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(16); // 6 + 10
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(20); // 16 + 10 → clamp 到 total
  });

  it('↓ 到下限被 clamp 到 1', () => {
    const onChange = vi.fn();
    render(<FrameScrubber value={1} total={20} onChange={onChange} />);
    fireEvent.keyDown(getInput(), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('total<=1 时只读，输入无效', () => {
    const onChange = vi.fn();
    render(<FrameScrubber value={1} total={1} onChange={onChange} />);
    expect(getInput()).toHaveAttribute('readonly');
    fireEvent.keyDown(getInput(), { key: 'ArrowUp' });
    // readOnly 下 change 不会触发，keyDown 仍会走 step，但值已在 [1,1]
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});
