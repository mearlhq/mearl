import { useRef } from 'react';

/** 协调显式结束编辑与随后发生的 blur，避免同一次操作重复提交。 */
export const useBlurCommitGuard = () => {
  const skipNextBlurRef = useRef(false);

  const beginEdit = () => {
    skipNextBlurRef.current = false;
  };

  const finishEdit = () => {
    skipNextBlurRef.current = true;
  };

  const consumeBlur = () => {
    const shouldSkip = skipNextBlurRef.current;
    skipNextBlurRef.current = false;
    return shouldSkip;
  };

  return { beginEdit, finishEdit, consumeBlur };
};
