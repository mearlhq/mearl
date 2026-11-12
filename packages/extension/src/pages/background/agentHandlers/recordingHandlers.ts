import {
  DomainPermissionError,
  startCdpRecording,
  type CdpRecordingStream,
  type HostToExtensionActionMap,
} from '@mearl/browser-core';
import { acquireDebuggerLease } from '../debuggerSessionManager';

type Request = HostToExtensionActionMap['__page_record']['request'];
type Authorize = (urls: Iterable<string>) => Promise<void>;

const recordings = new Map<string, CdpRecordingStream>();

export function hasPageRecording(recordingId: string): boolean {
  return recordings.has(recordingId);
}

export async function handlePageRecording(
  request: Request,
  authorize: Authorize,
  signal?: AbortSignal,
) {
  const { recordingId, operation } = request;
  if (operation !== 'start') {
    const recording = recordings.get(recordingId);
    if (operation === 'close') {
      await recording?.close();
      return;
    }
    if (!recording) throw new Error('RECORDING_INTERRUPTED: the debugger session ended');
    if (operation === 'read') return recording.read(request.size);
    if (operation !== 'stop') throw new Error('Unsupported recording operation');
    await recording.stop();
    return;
  }

  const { tabId, options, deadline } = request;
  const checkStartDeadline = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Recording start request timed out');
  };
  const urls = new Set<string>();
  const onCommitted: Parameters<typeof chrome.webNavigation.onCommitted.addListener>[0] = event => {
    if (event.tabId === tabId && event.frameId === 0) urls.add(event.url);
  };
  let detached = false;
  const abort = () =>
    void recordings
      .get(recordingId)
      ?.close()
      .catch(() => {});
  const lease = await acquireDebuggerLease(tabId, {
    consumer: 'page-recording',
    onInvalidated: () => {
      detached = true;
      recordings.delete(recordingId);
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
      signal?.removeEventListener('abort', abort);
    },
  });
  const target = { tabId };
  const collectCurrentUrl = async () => {
    const { url } = await chrome.tabs.get(tabId);
    if (url) urls.add(url);
  };
  const send = (method: string, params?: Record<string, unknown>) => {
    if (detached) throw new Error('RECORDING_INTERRUPTED: the debugger session ended');
    return chrome.debugger.sendCommand(target, method, params);
  };
  chrome.webNavigation.onCommitted.addListener(onCommitted);
  try {
    await collectCurrentUrl();
    await authorize(urls);
    checkStartDeadline();
    const stream = await startCdpRecording(send, options);
    try {
      checkStartDeadline();
    } catch (error) {
      if (!detached) await stream.close().catch(() => {});
      throw error;
    }
    const expiry = setTimeout(abort, 180_000);
    recordings.set(recordingId, {
      async stop() {
        await stream.stop();
        await collectCurrentUrl();
        try {
          await authorize(urls);
        } catch (error) {
          if (!(error instanceof DomainPermissionError)) throw error;
          throw new DomainPermissionError(
            'page_record',
            error.domain,
            `page_record: Recording discarded because access to "${error.domain}" is not authorized. Request authorization, then start a new recording.`,
          );
        }
      },
      read: size => stream.read(size),
      async close() {
        recordings.delete(recordingId);
        clearTimeout(expiry);
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
        signal?.removeEventListener('abort', abort);
        try {
          if (!detached) await stream.close();
        } finally {
          await lease.release();
        }
      },
    });
    signal?.addEventListener('abort', abort, { once: true });
  } catch (error) {
    chrome.webNavigation.onCommitted.removeListener(onCommitted);
    await lease.release();
    throw error;
  }
}
