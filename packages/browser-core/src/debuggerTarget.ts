/** A paused renderer must resume even when a preparation command never settles. */
export async function preparePausedDebuggerTarget<T>(
  prepare: (signal: AbortSignal) => Promise<T>,
  resume: () => Promise<unknown>,
  timeoutMs = 2000,
): Promise<T> {
  const controller = new AbortController();
  const withDeadline = async <R>(operation: () => Promise<R>, stage: string): Promise<R> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`Debugger target ${stage} timed out`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let result!: T;
  let preparationFailed = false;
  let preparationError: unknown;
  try {
    result = await withDeadline(() => prepare(controller.signal), 'preparation');
  } catch (error) {
    preparationFailed = true;
    preparationError = error;
  } finally {
    controller.abort();
  }
  try {
    await withDeadline(resume, 'resume');
  } catch (error) {
    // 恢复未确认时不能继续执行文档脚本；准备失败时保留原始错误。
    if (!preparationFailed) throw error;
  }
  if (preparationFailed) throw preparationError;
  return result;
}
