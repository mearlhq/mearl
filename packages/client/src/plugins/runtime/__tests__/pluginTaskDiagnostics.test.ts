import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPluginHostServer } from '../pluginHostServer.js';
import { PluginTaskClient } from '../../clients/pluginTasks.js';
import type { PluginDiagnosticReport } from '@mearl/browser-core';

let directory: string;
let service: Awaited<ReturnType<typeof startPluginHostServer>> | undefined;
const clients: PluginTaskClient[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-diagnostic-route-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await service?.close();
  service = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('diagnostic SDK and service routing', () => {
  it('forwards optional filters with the authenticated connection scope', async () => {
    service = await startPluginHostServer();
    const report: PluginDiagnosticReport = {
      version: 1,
      generatedAt: 1,
      host: service.host.tasks.host,
      protocolVersion: 5,
      selection: {},
      coverage: { scanLimited: false, tasksOmitted: 0, pagesOmitted: 0, byteLimited: false },
      tasks: [],
      pages: [],
      links: [],
    };
    const diagnose = vi.spyOn(service.host, 'diagnose').mockReturnValue(report);
    const client = new PluginTaskClient({ autoStart: false, socketPath: service.socketPath });
    clients.push(client);
    await expect(client.diagnose()).resolves.toEqual(report);
    expect(diagnose).toHaveBeenLastCalledWith(
      {},
      { access: 'public', bridge: 'service', source: 'sdk' },
    );
    const scoped = new PluginTaskClient({
      plugin: 'fixture',
      access: 'toolbox',
      source: 'toolbox',
      invoke: vi.fn(),
      autoStart: false,
      socketPath: service.socketPath,
    });
    clients.push(scoped);
    const options = {
      plugin: 'fixture',
      instanceId: 'page',
      includeErrorMessages: true,
      includeLocalPaths: false,
    };
    await expect(scoped.diagnose(options)).resolves.toEqual(report);
    expect(diagnose).toHaveBeenLastCalledWith(options, {
      access: 'toolbox',
      bridge: 'caller',
      source: 'toolbox',
      plugin: 'fixture',
    });
    diagnose.mockImplementationOnce(() => {
      throw Object.assign(new Error('not visible'), { code: 'PLUGIN_TASK_NOT_FOUND' });
    });
    await expect(scoped.diagnose({ taskId: 'hidden' })).rejects.toMatchObject({
      code: 'PLUGIN_TASK_NOT_FOUND',
      message: 'not visible',
    });
  });
});
