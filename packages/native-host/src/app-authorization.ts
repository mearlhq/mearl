import { nativeCapabilities } from './native-capability-services.js';

export type AppAuthorizationProgress = 'installing' | 'connected' | 'authorizing';
interface AuthorizationController {
  start(value: unknown, onProgress?: (phase: AppAuthorizationProgress) => void): Promise<{ browserId: string; qrSvg: string }>;
  wait(browserId: string, value: unknown, onProgress?: (phase: AppAuthorizationProgress) => void): Promise<Record<string, unknown>>;
  close(browserId: string): Promise<void>;
}
const sessions = new Map<string, AuthorizationController>();
function controller(hook: string): AuthorizationController {
  if (!/^[a-z][a-zA-Z0-9_.-]{0,95}$/.test(hook)) throw new Error('Invalid authorization capability');
  return nativeCapabilities.requireCustom<() => AuthorizationController>(hook)();
}
export async function startAppAuthorization(hook: string, value: unknown, progress?: (phase: AppAuthorizationProgress) => void) {
  const accepted = controller(hook);
  const result = await accepted.start(value, progress);
  sessions.set(result.browserId, accepted);
  return result;
}
export async function waitAppAuthorization(browserId: string, value: unknown, progress?: (phase: AppAuthorizationProgress) => void) {
  const accepted = sessions.get(browserId);
  if (!accepted) throw new Error('Authorization session is unavailable');
  return accepted.wait(browserId, value, progress);
}
export async function closeAppAuthorization(browserId: string): Promise<void> {
  const accepted = sessions.get(browserId);
  if (!accepted) return;
  try { await accepted.close(browserId); } finally { sessions.delete(browserId); }
}

export async function closeAppAuthorizations(): Promise<void> { await Promise.allSettled([...sessions.keys()].map(closeAppAuthorization)); }
