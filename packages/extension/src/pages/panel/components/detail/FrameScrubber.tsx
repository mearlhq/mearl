import { FC, MouseEvent as ReactMouseEvent, useRef, useState } from 'react';
import { clsx } from 'clsx';

interface FrameScrubberProps {
  /** 当前聚合到的帧数 */
  value: number;
  /** 总帧数（可调范围上限） */
  total: number;
  /** 用户调整后的帧数（已 clamp 到 [1, total]） */
  onChange: (next: number) => void;
  title?: string;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * 帧数调节器：一个内联数字，三种调整方式——
 * 在其上左右拖动 scrub、点击后直接输入、聚焦时按 ↑↓（Shift 步进 10）微调。
 * 用 type="text" 而非 number，天生没有 spinner 箭头，↑↓ 自行实现。
 * 拖动与点击靠移动阈值消歧：移动超过 3px 判为拖动并退出编辑，否则判为点击进入编辑。
 */
export const FrameScrubber: FC<FrameScrubberProps> = ({ value, total, onChange, title }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  // 编辑缓冲：聚焦时接管显示，未聚焦时回落到受控的 value（随拖动/流式实时更新）
  const [editing, setEditing] = useState<string | null>(null);
  const dragRef = useRef<{ startX: number; startVal: number; moved: boolean; stepPerPx: number }>({
    startX: 0,
    startVal: 0,
    moved: false,
    stepPerPx: 1,
  });

  const commit = (raw: string): void => {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n)) onChange(clamp(n, 1, total));
    setEditing(null);
  };

  const handleMouseDown = (e: ReactMouseEvent<HTMLInputElement>): void => {
    if (total <= 1) return;
    dragRef.current = {
      startX: e.clientX,
      startVal: value,
      moved: false,
      stepPerPx: Math.max(0.5, total / 500), // 约 500px 覆盖全部帧；小数据流每 2px 走 1 帧
    };
    const onMove = (ev: MouseEvent): void => {
      const s = dragRef.current;
      const dx = ev.clientX - s.startX;
      if (!s.moved && Math.abs(dx) < 3) return; // 阈值内暂视为点击
      if (!s.moved) {
        s.moved = true;
        inputRef.current?.blur(); // 判定为拖动：退出编辑态
        document.body.style.userSelect = 'none';
      }
      onChange(clamp(Math.round(s.startVal + dx * s.stepPerPx), 1, total));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      if (!dragRef.current.moved) {
        // 未移动：视为点击，聚焦并全选进入编辑
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const step = (delta: number): void => {
    const base = parseInt(editing ?? String(value), 10);
    const next = clamp((Number.isNaN(base) ? value : base) + delta, 1, total);
    setEditing(String(next));
    onChange(next);
  };

  const shown = editing ?? String(value);

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      value={shown}
      title={title}
      readOnly={total <= 1}
      onMouseDown={handleMouseDown}
      onFocus={() => setEditing(String(value))}
      onChange={e => {
        const digits = e.target.value.replace(/\D/g, '');
        if (!digits) {
          setEditing('');
          return;
        }
        const clamped = clamp(parseInt(digits, 10), 1, total);
        setEditing(String(clamped));
        onChange(clamped);
      }}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          step(e.shiftKey ? 10 : 1);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          step(e.shiftKey ? -10 : -1);
        } else if (e.key === 'Enter') {
          commit((e.target as HTMLInputElement).value);
          inputRef.current?.blur();
        } else if (e.key === 'Escape') {
          setEditing(null);
          inputRef.current?.blur();
        }
      }}
      style={{ width: `${Math.max(2, shown.length) + 0.5}ch` }}
      className={clsx(
        'mx-0.5 text-center tabular-nums bg-transparent p-0 border-none text-blue-500',
        'underline decoration-dotted underline-offset-2',
        'focus:outline-none focus:no-underline focus:bg-bg-hover rounded-sm',
        total > 1 ? 'cursor-ew-resize hover:text-blue-600 focus:cursor-text' : 'cursor-default',
      )}
    />
  );
};
