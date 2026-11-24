import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useHoldMetaPicker } from '../useHoldMetaPicker';
import {
  announceElementPickerSession,
  createElementPickerOwnerId,
  releaseElementPickerSession,
} from '../../utils/elementPickerSession';

it('starts on Command down and cancels on Command up', () => {
  const onStart = vi.fn();
  const onCancel = vi.fn();
  renderHook(() => useHoldMetaPicker({ enabled: true, isPicking: false, onStart, onCancel }));

  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' })));
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', repeat: true })));
  expect(onStart).toHaveBeenCalledOnce();

  act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })));
  expect(onCancel).toHaveBeenCalledOnce();
});

it('does not take ownership of an existing picker', () => {
  const onStart = vi.fn();
  const onCancel = vi.fn();
  renderHook(() => useHoldMetaPicker({ enabled: true, isPicking: true, onStart, onCancel }));

  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' })));
  act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })));

  expect(onStart).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});

it('cancels its picker when the panel loses focus', () => {
  const onCancel = vi.fn();
  renderHook(() =>
    useHoldMetaPicker({ enabled: true, isPicking: false, onStart: vi.fn(), onCancel }),
  );

  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' })));
  act(() => window.dispatchEvent(new Event('blur')));

  expect(onCancel).toHaveBeenCalledOnce();
});

it('can relinquish ownership when a button starts a new picker session', () => {
  const onCancel = vi.fn();
  const { result } = renderHook(() =>
    useHoldMetaPicker({ enabled: true, isPicking: false, onStart: vi.fn(), onCancel }),
  );

  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' })));
  act(() => result.current());
  act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })));

  expect(onCancel).not.toHaveBeenCalled();
});

it('does not replace another active picker session', () => {
  const onStart = vi.fn();
  const otherOwner = createElementPickerOwnerId();
  announceElementPickerSession(otherOwner);
  renderHook(() =>
    useHoldMetaPicker({ enabled: true, isPicking: false, onStart, onCancel: vi.fn() }),
  );

  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' })));

  expect(onStart).not.toHaveBeenCalled();
  releaseElementPickerSession(otherOwner);
});

it('does not cancel a picker session that takes over while Command is held', () => {
  const temporaryOwner = createElementPickerOwnerId();
  const otherOwner = createElementPickerOwnerId();
  const onCancel = vi.fn();
  renderHook(() =>
    useHoldMetaPicker({
      enabled: true,
      isPicking: false,
      onStart: () => announceElementPickerSession(temporaryOwner),
      onCancel,
    }),
  );

  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' })));
  act(() => announceElementPickerSession(otherOwner));
  act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })));

  expect(onCancel).not.toHaveBeenCalled();
  releaseElementPickerSession(otherOwner);
});
