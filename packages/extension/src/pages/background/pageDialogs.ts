import { PageDialogState, pageDialogSnapshot } from '@mearl/browser-core';
import { acquireDebuggerLease, type DebuggerLease } from './debuggerSessionManager';

interface Monitor {
  dialogs: PageDialogState;
  ready: Promise<DebuggerLease>;
  users: number;
  owner?: chrome.debugger.Debuggee;
}
const monitors = new Map<number, Monitor>();

export function getExtensionPageDialogs(tabId: number): PageDialogState | undefined {
  return monitors.get(tabId)?.dialogs;
}

function monitorPage(tabId: number): Monitor {
  const existing = monitors.get(tabId);
  if (existing) return existing;
  const dialogs = new PageDialogState();
  const monitor: Monitor = { dialogs, users: 0, ready: undefined! };
  const listener = (source: chrome.debugger.Debuggee, method: string, params?: any) => {
    if (source.tabId !== tabId) return;
    if (method === 'Page.javascriptDialogOpening') {
      monitor.owner = { ...source };
      dialogs.opened(params ?? {});
    } else if (method === 'Page.javascriptDialogClosed' &&
      (source as any).sessionId === (monitor.owner as any)?.sessionId) {
      monitor.owner = undefined;
      dialogs.closed();
    }
  };
  const release = () => {
    if (monitor.users || dialogs.pending || dialogs.busy || monitors.get(tabId) !== monitor) return;
    monitors.delete(tabId);
    chrome.debugger.onEvent.removeListener(listener);
    void monitor.ready.then(lease => lease.release()).catch(() => {});
  };
  dialogs.onIdle = release;
  monitors.set(tabId, monitor);
  chrome.debugger.onEvent.addListener(listener);
  // Page first: a pre-existing modal must be visible before enabling other domains.
  monitor.ready = acquireDebuggerLease(tabId, {
    consumer: 'page-dialog', domains: ['Page', 'Runtime'],
    onInvalidated: () => {
      chrome.debugger.onEvent.removeListener(listener);
      monitor.owner = undefined;
      dialogs.invalidate();
      release();
    },
  });
  void monitor.ready.catch(() => {
    chrome.debugger.onEvent.removeListener(listener);
    monitor.owner = undefined;
    dialogs.invalidate();
    release();
  });
  return monitor;
}

export async function withExtensionPageDialogs<T>(tabId: number, work: () => Promise<T>, interrupt = true): Promise<T> {
  const monitor = monitorPage(tabId);
  monitor.users += 1;
  try {
    return await monitor.dialogs.execute(async () => {
      await monitor.dialogs.command(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            monitor.ready,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Page monitoring could not start. A native dialog opened before attachment may block Chrome; close it manually, then retry.')), 5000); }),
          ]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      });
      return work();
    }, interrupt);
  } finally {
    monitor.users -= 1;
    if (!monitor.dialogs.pending && !monitor.dialogs.busy) monitor.dialogs.onIdle?.();
  }
}

export function sendPageCommand(target: chrome.debugger.Debuggee, method: string, params?: any, onDispatch?: () => void): Promise<any> {
  const send = () => { onDispatch?.(); return chrome.debugger.sendCommand(target, method, params); };
  const release = (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp') ||
    (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') ||
    (method === 'Input.dispatchTouchEvent' && params?.type === 'touchEnd');
  const dialogs = target.tabId === undefined ? undefined : getExtensionPageDialogs(target.tabId);
  return dialogs && !release ? dialogs.command(send) : send();
}

export function runPageScript<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  const dialogs = getExtensionPageDialogs(tabId);
  return dialogs ? dialogs.command(work) : work();
}

/** Called before preparation and observation; neither path evaluates page JS. */
export async function extensionPageDialogShortcut(action: string, data: any): Promise<{ data: any } | undefined> {
  const monitor = monitors.get(data?.tabId);
  if (action === 'page_press' && data?.dialogId !== undefined) {
    if (!monitor?.owner) throw new Error('page_press: dialogId is stale or no native dialog is open. Run page_snapshot.');
    return { data: await monitor.dialogs.press(data, async params => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          chrome.debugger.sendCommand(monitor.owner!, 'Page.handleJavaScriptDialog', params),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native dialog acknowledgement timed out')), 5000); }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }) };
  }
  if (action === 'page_press' && data?.promptText !== undefined) throw new Error('page_press: promptText requires dialogId.');
  if (action === 'page_snapshot' && monitor?.dialogs.pending) {
    const snapshot = pageDialogSnapshot(monitor.dialogs, data?.mode, data?.maxChars);
    const tab = await chrome.tabs.get(data.tabId);
    return { data: { ...snapshot, url: tab.url ?? '', title: tab.title ?? '' } };
  }
  return undefined;
}
