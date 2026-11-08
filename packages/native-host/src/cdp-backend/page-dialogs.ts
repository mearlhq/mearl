import { PageDialogState, pageDialogSnapshot } from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import type { CdpClient, CdpChildSession } from './client.js';

type Client = CdpClient | CdpChildSession;
const states = new WeakMap<PageSession, { dialogs: PageDialogState; owner?: Client; cleanup: Set<() => void> }>();

export function getCdpPageDialogs(session: PageSession): PageDialogState {
  let state = states.get(session);
  if (!state) {
    state = { dialogs: new PageDialogState(), cleanup: new Set() };
    const current = state;
    current.dialogs.onIdle = () => {
      const cleanup = [...current.cleanup];
      current.cleanup.clear();
      for (const dispose of cleanup) dispose();
    };
    states.set(session, state);
  }
  return state.dialogs;
}

/** A temporary frame connection that owns a modal must survive until its handling ack. */
export function deferCdpDialogCleanup(session: PageSession, cleanup: () => void): void {
  const dialogs = getCdpPageDialogs(session);
  if (dialogs.pending || dialogs.busy) states.get(session)!.cleanup.add(cleanup);
  else cleanup();
}

/** Subscribe before Page.enable, including on temporary frame sessions. */
export function monitorCdpPageDialogs(session: PageSession, client = session.client): () => void {
  const dialogs = getCdpPageDialogs(session);
  const state = states.get(session)!;
  const remove = [
    client.on('Page.javascriptDialogOpening', event => {
      state.owner = client;
      dialogs.opened(event);
    }),
    client.on('Page.javascriptDialogClosed', () => {
      if (state.owner !== client) return;
      state.owner = undefined;
      dialogs.closed();
    }),
    client.on('Inspector.detached', () => {
      if (state.owner && state.owner !== client) return;
      state.owner = undefined;
      dialogs.invalidate();
    }),
  ];
  return () => { for (const dispose of remove) dispose(); };
}

/** Only page execution goes through this gate; lifecycle and Fetch cleanup remain independent. */
export function sendCdpPageCommand(
  session: PageSession,
  client: Pick<Client, 'sendCommand'>,
  method: string,
  params: Record<string, any> = {},
  timeoutMs?: number,
  onDispatch?: () => void,
): Promise<any> {
  const send = () => {
    onDispatch?.();
    return timeoutMs === undefined ? client.sendCommand(method, params) : client.sendCommand(method, params, timeoutMs);
  };
  const release = (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') ||
    (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') ||
    (method === 'Input.dispatchTouchEvent' && params.type === 'touchEnd');
  return release ? send() : getCdpPageDialogs(session).command(send);
}

export function snapshotCdpPageDialog(session: PageSession, data: any): any {
  const snapshot = pageDialogSnapshot(getCdpPageDialogs(session), data?.mode, data?.maxChars);
  return snapshot ? { ...snapshot, url: session.url, title: '' } : undefined;
}

export function pressCdpPageDialog(session: PageSession, data: any): Promise<any> {
  const state = states.get(session);
  if (!state?.owner) return Promise.reject(new Error('page_press: dialogId is stale or no native dialog is open. Run page_snapshot.'));
  return state.dialogs.press(data, params => state.owner!.sendCommand('Page.handleJavaScriptDialog', params, 5000));
}
