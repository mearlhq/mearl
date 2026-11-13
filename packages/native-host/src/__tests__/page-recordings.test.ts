import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlSessionManager } from '../control-session-manager.js';

const bytes = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112]);

function setup() {
  const stream = {
    isAlive: vi.fn(async () => true),
    stop: vi.fn(async () => {}),
    read: vi.fn(async () => ({ data: bytes.toString('base64'), base64Encoded: true, eof: true })),
    close: vi.fn(async () => {}),
  };
  const openRecording = vi.fn(async () => stream);
  const manager = new ControlSessionManager({
    browserId: () => 'test-browser',
    transport: () => 'extension',
    invoke: vi.fn(async () => ({})),
    cleanup: vi.fn(async () => {}),
    download: vi.fn(),
    notify: vi.fn(),
    openRecording,
  });
  return { manager, openRecording, stream };
}

afterEach(() => vi.useRealTimers());

describe('page_record', () => {
  it('keeps the stream on the original transport and reuses the completed artifact', async () => {
    const { manager, openRecording, stream } = setup();
    try {
      const start = await manager.invoke('page_record', { operation: 'start', tabId: 42 });
      expect(start.browserId).toBe('test-browser');
      expect(openRecording).toHaveBeenCalledWith('extension', 42, start.recordingId, {
        maxWidth: 1280,
        maxHeight: 720,
        frameRate: 30,
        audio: false,
      });
      await expect(
        manager.invoke('page_record', { operation: 'start', tabId: 42 }),
      ).rejects.toThrow('already recording');
      const stop = { operation: 'stop', recordingId: start.recordingId };
      await expect(manager.invoke('page_record', stop, undefined, 'cdp')).rejects.toThrow(
        'RECORDING_NOT_FOUND',
      );
      const [first, second] = await Promise.all([
        manager.invoke('page_record', stop),
        manager.invoke('page_record', stop),
      ]);
      expect(first).toEqual(second);
      expect(stream.stop).toHaveBeenCalledTimes(1);
      expect(stream.close).toHaveBeenCalledTimes(1);
      expect(await manager.artifacts.read(first.recording.artifactId, 0)).toEqual({
        base64: bytes.toString('base64'),
        bytes: bytes.length,
        totalBytes: bytes.length,
      });
    } finally {
      await manager.releaseBrowser(async () => {});
      await manager.artifacts.dispose();
    }
  });

  it('finalizes at the duration limit and retains the result for stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager, stream } = setup();
    try {
      const start = await manager.invoke('page_record', { operation: 'start', tabId: 42 });
      await vi.advanceTimersByTimeAsync(start.maxDurationMs);
      expect(stream.stop).toHaveBeenCalledTimes(1);
      const result = await manager.invoke('page_record', {
        operation: 'stop',
        recordingId: start.recordingId,
      });
      expect(result.recording.bytes).toBe(bytes.length);
      await expect(
        manager.invoke('page_record', {
          operation: 'status',
          recordingId: start.recordingId,
        }),
      ).resolves.toMatchObject({
        state: 'ready',
        stopReason: 'duration_limit',
        recording: result.recording,
      });
      expect(stream.stop).toHaveBeenCalledTimes(1);
    } finally {
      await manager.releaseBrowser(async () => {});
      await manager.artifacts.dispose();
    }
  });

  it('reports recording and finalizing without issuing a second stop or waiting for the export', async () => {
    const { manager, stream } = setup();
    const stopStarted = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    stream.stop.mockImplementationOnce(async () => {
      stopStarted.resolve();
      await stopped.promise;
    });
    try {
      const start = await manager.invoke('page_record', { operation: 'start', tabId: 42 });
      const status = { operation: 'status', recordingId: start.recordingId };
      const active = await manager.invoke('page_record', status);
      expect(active).toMatchObject({ state: 'recording', browserId: start.browserId, tabId: 42 });
      expect(active.autoStopAt - active.startedAt).toBe(start.maxDurationMs);
      expect(stream.stop).not.toHaveBeenCalled();
      const stop = manager.invoke('page_record', { ...status, operation: 'stop' });
      try {
        await stopStarted.promise;
        await expect(manager.invoke('page_record', status)).resolves.toMatchObject({
          state: 'finalizing',
          stopReason: 'requested',
        });
      } finally {
        stopped.resolve();
        await stop;
      }
      await expect(manager.invoke('page_record', status)).resolves.toMatchObject({
        state: 'ready',
        stopReason: 'requested',
        recording: (await stop).recording,
      });
      expect(stream.stop).toHaveBeenCalledOnce();
    } finally {
      await manager.releaseBrowser(async () => {});
      await manager.artifacts.dispose();
    }
  });

  it('reports a lost debugger as interrupted without stopping it', async () => {
    const { manager, stream } = setup();
    try {
      const start = await manager.invoke('page_record', { operation: 'start', tabId: 42 });
      const status = { operation: 'status', recordingId: start.recordingId };
      stream.isAlive.mockResolvedValueOnce(false);
      await expect(manager.invoke('page_record', status)).resolves.toMatchObject({
        state: 'interrupted',
        error: 'The recording tab or debugger session ended',
      });
      await expect(manager.invoke('page_record', status)).resolves.toMatchObject({
        state: 'interrupted',
      });
      expect(stream.isAlive).toHaveBeenCalledOnce();
      expect(stream.stop).not.toHaveBeenCalled();
    } finally {
      await manager.releaseBrowser(async () => {});
      await manager.artifacts.dispose();
    }
  });

  it('reports why finalization failed without returning a partial artifact', async () => {
    const { manager, stream } = setup();
    try {
      const start = await manager.invoke('page_record', { operation: 'start', tabId: 42 });
      stream.read.mockRejectedValueOnce(new Error('Chrome disconnected during export'));
      await expect(
        manager.invoke('page_record', {
          operation: 'stop',
          recordingId: start.recordingId,
        }),
      ).rejects.toThrow('Chrome disconnected during export');
      const status = await manager.invoke('page_record', {
        operation: 'status',
        recordingId: start.recordingId,
      });
      expect(status).toMatchObject({
        state: 'interrupted',
        error: 'Chrome disconnected during export',
      });
      expect(status.recording).toBeUndefined();
      expect(stream.close).toHaveBeenCalledOnce();
    } finally {
      await manager.releaseBrowser(async () => {});
      await manager.artifacts.dispose();
    }
  });

  it('closes a recording that starts after the caller deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { manager, openRecording, stream } = setup();
    const deadline = Date.now() + 100;
    openRecording.mockImplementationOnce(async () => {
      vi.setSystemTime(deadline);
      return stream;
    });
    const request = { operation: 'start', tabId: 42 };
    try {
      await expect(
        manager.invoke('page_record', request, undefined, undefined, 'local', deadline),
      ).rejects.toThrow('deadline exceeded');
      expect(stream.close).toHaveBeenCalledOnce();
      await expect(manager.invoke('page_record', request)).resolves.toMatchObject({
        operation: 'start',
        tabId: 42,
      });
    } finally {
      await manager.releaseBrowser(async () => {});
      await manager.artifacts.dispose();
    }
  });

  it('discards an active recording when its session hands off', async () => {
    const { manager, stream } = setup();
    const session = manager.registry.create('extension');
    try {
      const start = await manager.invoke(
        'page_record',
        { operation: 'start', tabId: 42 },
        session.sessionId,
      );
      await manager.userControl(session.sessionId, 'handoff');
      expect(stream.close).toHaveBeenCalledTimes(1);
      await expect(
        manager.invoke(
          'page_record',
          {
            operation: 'status',
            recordingId: start.recordingId,
          },
          session.sessionId,
        ),
      ).resolves.toMatchObject({ state: 'interrupted' });
      await expect(
        manager.invoke('page_record', {
          operation: 'status',
          recordingId: start.recordingId,
        }),
      ).rejects.toThrow('RECORDING_NOT_FOUND');
      await manager.userControl(session.sessionId, 'resume');
      await expect(
        manager.invoke(
          'page_record',
          {
            operation: 'stop',
            recordingId: start.recordingId,
          },
          session.sessionId,
        ),
      ).rejects.toThrow('RECORDING_NOT_FOUND');
    } finally {
      await manager.manageSession({ operation: 'end' }, session.sessionId);
      await manager.artifacts.dispose();
    }
  });

  it.each(['handoff', 'release'] as const)(
    'stops a recording started without a session when its tab is later claimed and handed over via %s',
    async operation => {
      const { manager, stream } = setup();
      const start = await manager.invoke('page_record', { operation: 'start', tabId: 42 });
      const { session } = await manager.invoke('page_snapshot', { tabId: 42 }, 'new');
      try {
        await manager.userControl(session.sessionId, operation);
        expect(stream.close).toHaveBeenCalledOnce();
      } finally {
        await manager.manageSession({ operation: 'end' }, session.sessionId);
        await manager.releaseBrowser(async () => {});
        await manager.artifacts.dispose();
      }
      await expect(
        manager.invoke('page_record', {
          operation: 'stop',
          recordingId: start.recordingId,
        }),
      ).rejects.toThrow('RECORDING_NOT_FOUND');
    },
  );
});
