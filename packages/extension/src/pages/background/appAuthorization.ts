import { startNativeHostRequestSession, type NativeHostRequestSession } from './nativeHostRequest';

interface Owner { tabId: number; frameId?: number; documentId?: string }
interface AcceptedSession { owner: Owner; transport: NativeHostRequestSession; browserId: string; timeout: ReturnType<typeof setTimeout> }
const sessions = new Map<string, AcceptedSession>();
const owns = (left: Owner, right: Owner) => left.tabId === right.tabId && left.frameId === right.frameId && left.documentId === right.documentId;

export async function startAppAuthorization(owner: Owner, hook: string, params: unknown, progress?: (value: unknown) => void) {
  const started = await startNativeHostRequestSession('app_authorization_start', { hook, params }, 280_000, progress);
  const value = started.value as { browserId?: string; qrSvg?: string };
  if (typeof value?.browserId !== 'string' || typeof value.qrSvg !== 'string') { started.session.close(); throw new Error('Invalid authorization pairing'); }
  const id = crypto.randomUUID();
  const timeout = setTimeout(() => { void finishAppAuthorization('close', owner, id).catch(() => {}); }, 600_000);
  sessions.set(id, { owner, transport: started.session, browserId: value.browserId, timeout });
  return { browserId: id, qrSvg: value.qrSvg };
}
export async function finishAppAuthorization(operation: 'wait' | 'close', owner: Owner, id: string, params?: unknown, progress?: (value: unknown) => void) {
  const accepted = sessions.get(id);
  if (!accepted || !owns(accepted.owner, owner)) {
    if (!accepted && operation === 'close') return {};
    throw new Error('Authorization session is unavailable');
  }
  try {
    return await accepted.transport.request(`app_authorization_${operation}`, { browserId: accepted.browserId, params }, operation === 'wait' ? 140_000 : 30_000, progress);
  } finally {
    clearTimeout(accepted.timeout); sessions.delete(id); accepted.transport.close();
  }
}
