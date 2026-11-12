import type { PageRecordingOptions } from './browserActionProtocol.js';

export interface CdpRecordingStream {
  stop(): Promise<void>;
  read(size: number): Promise<{ data: string; base64Encoded?: boolean; eof: boolean }>;
  close(): Promise<void>;
}

export async function startCdpRecording(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  options: Required<PageRecordingOptions>,
): Promise<CdpRecordingStream> {
  let handle: string;
  try {
    const result = (await send('Page.startScreenRecording', { ...options })) as { stream: string };
    handle = result.stream;
  } catch (error) {
    if (error instanceof Error && /-32601|wasn't found|method not found/i.test(error.message))
      throw new Error('This browser does not support native page recording (Chrome 153+ required)');
    throw error;
  }
  let stopPromise: Promise<void> | undefined;
  let closed = false;
  const stop = () => {
    stopPromise ??= send('Page.stopScreenRecording').then(response => {
      handle = (response as { stream: string }).stream || handle;
    });
    return stopPromise;
  };
  return {
    stop,
    async read(size) {
      if (!stopPromise || closed) throw new Error('Recording stream is unavailable');
      await stopPromise;
      return (await send('IO.read', { handle, size })) as Awaited<
        ReturnType<CdpRecordingStream['read']>
      >;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await stop();
      } finally {
        if (handle) await send('IO.close', { handle });
      }
    },
  };
}
