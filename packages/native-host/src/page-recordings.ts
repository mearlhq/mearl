import { randomUUID } from 'node:crypto';
import type {
  BrowserArtifact,
  BrowserTransport,
  CdpRecordingStream,
  PageRecordingOptions,
  PageRecordingStatus,
  PageRecordingStopReason,
  PageRecordResult,
} from '@mearl/browser-core';
import { ARTIFACT_CHUNK_BYTES, type BrowserArtifactStore } from './browser-artifacts.js';
import { assertBrowserRequestDeadline } from './control-session.js';

const MAX_DURATION_MS = 60_000;
const RESULT_TTL_MS = 300_000;

export type OpenRecording = (
  transport: BrowserTransport,
  tabId: number,
  recordingId: string,
  options: Required<PageRecordingOptions>,
) => Promise<CdpRecordingStream & { isAlive(): boolean | Promise<boolean> }>;

interface Recording {
  id: string;
  tabId: number;
  transport: BrowserTransport;
  sessionId?: string;
  stream: Awaited<ReturnType<OpenRecording>>;
  timer: NodeJS.Timeout;
  startedAt: number;
  status: PageRecordingStatus;
  result?: Promise<BrowserArtifact>;
}

function isActive({ status }: Recording): boolean {
  return status.state === 'recording' || status.state === 'finalizing';
}

function option(value: unknown, fallback: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  return value;
}

export class PageRecordings {
  private recordings = new Map<string, Recording>();

  constructor(
    private artifacts: BrowserArtifactStore,
    private open: OpenRecording,
    private browserId: () => string,
  ) {}

  async start(
    tabId: number,
    transport: BrowserTransport,
    sessionId: string | undefined,
    options: PageRecordingOptions,
    deadline?: number,
  ): Promise<PageRecordResult> {
    assertBrowserRequestDeadline(deadline);
    if (transport === 'provider') throw new Error('Page recording requires a Chrome connection');
    if (typeof options.audio !== 'boolean' && options.audio !== undefined)
      throw new Error('audio must be a boolean');
    if (
      [...this.recordings.values()].some(
        record => record.transport === transport && record.tabId === tabId && isActive(record),
      )
    )
      throw new Error('This tab is already recording');
    const id = randomUUID();
    const stream = await this.open(transport, tabId, id, {
      maxWidth: option(options.maxWidth, 1280, 1920, 'maxWidth'),
      maxHeight: option(options.maxHeight, 720, 1080, 'maxHeight'),
      frameRate: option(options.frameRate, 30, 60, 'frameRate'),
      audio: options.audio ?? false,
    });
    try {
      assertBrowserRequestDeadline(deadline);
    } catch (error) {
      await stream.close().catch(() => {});
      throw error;
    }
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      void this.finish(recording, 'duration_limit').catch(() => {});
    }, MAX_DURATION_MS).unref();
    const recording: Recording = {
      id,
      tabId,
      transport,
      sessionId,
      stream,
      timer,
      startedAt,
      status: { state: 'recording' },
    };
    this.recordings.set(id, recording);
    return {
      operation: 'start',
      tabId,
      browserId: this.browserId(),
      recordingId: id,
      maxDurationMs: MAX_DURATION_MS,
    };
  }

  resolve(id: unknown, sessionId: string | undefined, transport: BrowserTransport): Recording {
    const record = typeof id === 'string' ? this.recordings.get(id) : undefined;
    if (!record || record.sessionId !== sessionId || record.transport !== transport)
      throw new Error('RECORDING_NOT_FOUND: use the original browser and control session');
    return record;
  }

  async status(recording: Recording): Promise<PageRecordResult> {
    if (recording.status.state === 'recording') {
      const alive = await recording.stream.isAlive();
      if (!alive && recording.status.state === 'recording') {
        this.interrupt(recording, 'The recording tab or debugger session ended');
      }
    }
    return {
      operation: 'status',
      tabId: recording.tabId,
      browserId: this.browserId(),
      recordingId: recording.id,
      startedAt: recording.startedAt,
      autoStopAt: recording.startedAt + MAX_DURATION_MS,
      ...recording.status,
    };
  }

  async stop(recording: Recording): Promise<PageRecordResult> {
    if (recording.status.state === 'interrupted' && !recording.result)
      throw new Error(`RECORDING_NOT_FOUND: ${recording.status.error}`);
    const artifact = await this.finish(recording, 'requested');
    return {
      operation: 'stop',
      tabId: recording.tabId,
      recordingId: recording.id,
      recording: artifact,
    };
  }

  async discard(
    transport: BrowserTransport,
    scope: { sessionId?: string } | { tabIds: readonly number[] },
  ): Promise<void> {
    const recordings = [...this.recordings.values()].filter(
      record =>
        record.transport === transport &&
        ('tabIds' in scope
          ? scope.tabIds.includes(record.tabId) && isActive(record)
          : record.sessionId === scope.sessionId),
    );
    await Promise.all(
      recordings.map(async record => {
        if ('tabIds' in scope) {
          if (record.result) await record.result.catch(() => {});
          else {
            this.interrupt(record, 'The tab was closed or control was handed over');
            await record.stream.close().catch(() => {});
          }
          return;
        }
        this.forget(record);
        if (record.result) await record.result.catch(() => {});
        else if (isActive(record)) await record.stream.close().catch(() => {});
      }),
    );
  }

  private forget(recording: Recording): void {
    clearTimeout(recording.timer);
    this.recordings.delete(recording.id);
  }

  private interrupt(recording: Recording, error: string): void {
    recording.status = { state: 'interrupted', error };
    this.retainResult(recording);
  }

  private retainResult(recording: Recording): void {
    clearTimeout(recording.timer);
    if (this.recordings.has(recording.id))
      recording.timer = setTimeout(() => this.forget(recording), RESULT_TTL_MS).unref();
  }

  private finish(
    recording: Recording,
    stopReason: PageRecordingStopReason,
  ): Promise<BrowserArtifact> {
    if (recording.result) return recording.result;
    clearTimeout(recording.timer);
    recording.status = { state: 'finalizing', stopReason };
    recording.result = this.save(recording).then(
      artifact => {
        const result = { ...artifact, browserId: this.browserId() };
        recording.status = { state: 'ready', stopReason, recording: result };
        this.retainResult(recording);
        return result;
      },
      error => {
        this.interrupt(recording, error instanceof Error ? error.message : String(error));
        throw error;
      },
    );
    return recording.result;
  }

  private async save(recording: Recording): Promise<BrowserArtifact> {
    const { stream, sessionId } = recording;
    let artifact: BrowserArtifact | undefined;
    let bytes = 0;
    try {
      await stream.stop();
      artifact = await this.artifacts.create(`recording-${recording.id}.mp4`, sessionId);
      for (;;) {
        const chunk = await stream.read(ARTIFACT_CHUNK_BYTES);
        if (chunk.data) {
          if (!chunk.base64Encoded) throw new Error('Chrome returned a non-binary recording chunk');
          const written = await this.artifacts.write(
            artifact.artifactId,
            bytes,
            chunk.data,
            sessionId,
          );
          bytes = written.bytes;
        } else if (!chunk.eof) {
          throw new Error('Chrome returned an empty recording chunk');
        }
        if (chunk.eof) break;
      }
      if (!bytes) throw new Error('Chrome returned an empty recording');
      return this.artifacts.complete(artifact.artifactId, bytes, sessionId);
    } catch (error) {
      if (artifact) await this.artifacts.remove(artifact.artifactId, sessionId).catch(() => {});
      throw error;
    } finally {
      await stream.close().catch(() => {});
    }
  }
}
