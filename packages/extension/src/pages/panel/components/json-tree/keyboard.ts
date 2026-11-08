import type { KeyboardEvent } from 'react';

/** 输入法确认候选词时，Enter / Escape 应交给 IME 处理，不能触发编辑快捷键。 */
export const isImeComposing = (event: KeyboardEvent): boolean => {
  const nativeEvent = event.nativeEvent;
  return nativeEvent.isComposing || nativeEvent.keyCode === 229;
};
