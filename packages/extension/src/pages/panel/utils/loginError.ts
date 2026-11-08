/**
 * 判断错误信息是否为登录态失效
 */
export function isLoginError(error?: string): boolean {
  if (!error) return false;
  const normalizedError = error.toLowerCase();
  return (
    normalizedError.includes('未登录') ||
    normalizedError.includes('请登录') ||
    normalizedError.includes('login') ||
    normalizedError.includes('not authenticated') ||
    normalizedError.includes('unauthorized') ||
    normalizedError.includes('forbidden')
  );
}
