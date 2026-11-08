import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticReport,
  normalizeModelDiagnostic,
  normalizeDiagnosticOptions,
  MAX_PLUGIN_DIAGNOSTIC_BYTES,
} from '../pluginDiagnostics.js';
import type { PluginTaskRecord } from '../pluginTaskStore.js';

const host = { hostId: randomUUID(), epoch: randomUUID() };
const scope = { access: 'public' as const, source: 'sdk' as const, bridge: 'service' as const };
function record(plugin = 'sample'): PluginTaskRecord {
  return {
    task: {
      taskId: `pt_${host.hostId}_${randomUUID()}`,
      host,
      plugin,
      installationId: randomUUID(),
      revision: 'a'.repeat(64),
      kind: 'model',
      command: 'model',
      input: { prompt: 'PRIVATE_INPUT', request: { model: 'requested', prompt: 'PRIVATE_PROMPT' } },
      cwd: '/PRIVATE_CWD',
      state: 'error',
      source: 'sdk',
      sequence: 3,
      createdAt: 1,
      updatedAt: 2,
      progress: { data: 'PRIVATE_PROGRESS' },
      error: {
        code: 'TEST_FAILURE',
        message: 'PRIVATE_MESSAGE',
        details: { secret: 'PRIVATE_DETAILS' },
        metadata: { token: 'PRIVATE_TOKEN' },
      },
    },
    access: 'public',
    events: [{ sequence: 3, time: 2, type: 'state', state: 'error' }],
    checkpoint: {
      data: 'PRIVATE_CHECKPOINT',
      version: 1,
      schemaHash: 'hash',
      sequence: 1,
      updatedAt: 1,
    },
    diagnostics: {
      executorAttempted: true,
      model: {
        runtime: {
          executable: '/PRIVATE_PATH/codex',
          version: '1',
          selection: 'explicit',
          started: true,
        },
        configuration: {
          source: 'environment',
          filePresent: true,
          home: '/PRIVATE_HOME',
          baseProvider: 'openai',
        },
        authentication: 'chatgpt',
      },
    },
  };
}
const report = (records: PluginTaskRecord[], options = {}) =>
  buildDiagnosticReport(host, scope, options, { records, limited: false }, []);

describe('metadata-only plugin diagnostics', () => {
  it('projects safe fields and requires explicit opt-in for paths and error messages', () => {
    const source = record();
    expect(JSON.stringify(report([source]))).not.toContain('PRIVATE_');
    expect(report([source]).tasks[0]).toMatchObject({
      model: { requestedModel: 'requested', runtime: { executable: 'codex' } },
      failure: { code: 'TEST_FAILURE' },
      history: { gap: true },
      executor: { state: 'unknown' },
    });
    const exported = JSON.stringify(
      report([source], { includeLocalPaths: true, includeErrorMessages: true }),
    );
    expect(exported).toContain('PRIVATE_MESSAGE');
    expect(exported).toContain('PRIVATE_HOME');
    for (const secret of [
      'PRIVATE_INPUT',
      'PRIVATE_PROMPT',
      'PRIVATE_CWD',
      'PRIVATE_PROGRESS',
      'PRIVATE_DETAILS',
      'PRIVATE_TOKEN',
      'PRIVATE_CHECKPOINT',
    ])
      expect(exported).not.toContain(secret);
    expect(source.diagnostics?.model?.runtime?.executable).toBe('/PRIVATE_PATH/codex');
  });
  it('filters caller scope before expanding relations or counting omissions', () => {
    const root = record(),
      child = record('other'),
      hidden = record();
    root.access = 'toolbox';
    child.task.parentTaskId = root.task.taskId;
    hidden.task.parentTaskId = root.task.taskId;
    const value = buildDiagnosticReport(
      host,
      { ...scope, access: 'toolbox', plugin: 'sample' },
      { taskId: root.task.taskId },
      { records: [root, child, hidden], limited: false },
      [],
    );
    expect(value.tasks.map(task => task.taskId)).toEqual([root.task.taskId]);
    expect(value.links).toEqual([]);
    expect(value.coverage.tasksOmitted).toBe(0);
    expect(JSON.stringify(value)).not.toContain(child.task.taskId);
    expect(() =>
      buildDiagnosticReport(
        host,
        scope,
        { taskId: root.task.taskId, plugin: 'other' },
        { records: [root, child], limited: false },
        [],
      ),
    ).toThrow('not found');
  });
  it('links only selected nodes and preserves historical page binding without asserting liveness', () => {
    const root = record(),
      child = record();
    child.task.parentTaskId = root.task.taskId;
    child.diagnostics!.page = {
      instanceId: `pi_${randomUUID()}`,
      browserSessionId: randomUUID(),
      tabId: 1,
      frameId: 0,
      documentId: 'old',
    };
    const value = report([root, child], { taskId: child.task.taskId });
    expect(value.links).toEqual([
      { from: root.task.taskId, to: child.task.taskId, kind: 'parent' },
    ]);
    expect(value.pages[0]).toMatchObject({
      observation: 'historical-binding',
      binding: { documentId: 'old' },
    });
    expect(value.pages[0].state).toBeUndefined();
  });
  it('uses positive stop evidence and does not infer cleanup from terminal task state', () => {
    const source = record();
    expect(report([source]).tasks[0].executor.state).toBe('unknown');
    source.diagnostics = { executorAttempted: false };
    expect(report([source]).tasks[0].executor.state).toBe('never-started');
    source.diagnostics = { executorAttempted: true, executorStoppedAt: 42 };
    expect(report([source]).tasks[0].executor).toMatchObject({
      state: 'stop-confirmed',
      stoppedAt: 42,
    });
  });
  it('bounds UTF-8 report and error bytes with explicit output and scan coverage', () => {
    const records = Array.from({ length: 160 }, () => {
      const source = record();
      source.task.error!.message = '译文😀'.repeat(10000);
      return source;
    });
    const value = buildDiagnosticReport(
      host,
      scope,
      { includeErrorMessages: true },
      { records, limited: true },
      [],
    );
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(
      MAX_PLUGIN_DIAGNOSTIC_BYTES,
    );
    expect(value.coverage).toMatchObject({ scanLimited: true, byteLimited: true });
    expect(value.coverage.tasksOmitted).toBeGreaterThan(32);
    for (const task of value.tasks) {
      expect(task.failure?.messageTruncated).toBe(true);
      expect(task.failure?.message).not.toContain('\uFFFD');
    }
  });
  it('whitelists worker diagnostic fields and validates selection options', () => {
    expect(
      normalizeModelDiagnostic({
        requestedModel: 'model',
        authentication: 'token',
        token: 'PRIVATE',
        runtime: { executable: 'codex', selection: 'explicit', token: 'PRIVATE' },
        retryCount: -1,
      }),
    ).toEqual({ requestedModel: 'model', runtime: { executable: 'codex', selection: 'explicit' } });
    expect(() => normalizeDiagnosticOptions({ includeErrorMessages: 'yes' })).toThrow();
    expect(() => normalizeDiagnosticOptions({ input: {} })).toThrow();
    expect(() => normalizeDiagnosticOptions({ taskId: '../file' })).toThrow();
  });
});
