import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { lstatSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { invokeLocalHost } from '@mearl/client/local';
import { cleanupPluginRuntime, pluginDirectory } from '@mearl/client/plugin';
import { listInstalledProviders } from '@mearl/provider/host';
import {
  isProcessOwnerAlive,
  listRecordFiles,
  processIdentity,
  readRecord,
  type DaemonRecord,
} from '@mearl/daemon-core';

function liveRecords(directory: string): DaemonRecord[] {
  return listRecordFiles(directory)
    .map(file => readRecord(file))
    .filter((record): record is DaemonRecord => record !== null && isProcessOwnerAlive(record));
}

function nativeHostCommand(pid: number): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
  };
  if (process.platform === 'win32') {
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      options,
    );
  }
  return execFileSync('ps', ['-p', String(pid), '-o', 'command='], options);
}

async function stopNativeHost(record: DaemonRecord): Promise<void> {
  const { pid } = record;
  const identity =
    typeof record.processIdentity === 'string' ? record.processIdentity : processIdentity(pid);
  try {
    const command = nativeHostCommand(pid);
    if (
      pid !== process.pid &&
      identity &&
      /(?:^|[\\/\s"])(?:native-host[\\/]dist[\\/]index\.js|mearl-native-host)(?=["\s]|$)/.test(
        command,
      ) &&
      (await confirmsNativeHostOwner(record, command)) &&
      processIdentity(pid) === identity
    ) {
      process.kill(pid, 'SIGTERM');
      const deadline = Date.now() + 5_000;
      while (isProcessOwnerAlive({ pid, processIdentity: identity }) && Date.now() < deadline)
        await setTimeout(50);
    }
  } catch (error) {
    if (isProcessOwnerAlive({ pid, processIdentity: identity }))
      throw new Error(`Could not stop Mearl Native Host (PID ${pid})`, { cause: error });
  }
  if (isProcessOwnerAlive({ pid, processIdentity: identity }))
    throw new Error(`Could not stop Mearl Native Host (PID ${pid})`);
}

async function confirmsNativeHostOwner(record: DaemonRecord, command: string): Promise<boolean> {
  if (typeof record.token === 'string')
    return (
      /^[a-f0-9-]{36}$/.test(record.token) &&
      command.trimEnd().endsWith(`--provider-control ${record.token}`)
    );
  if (typeof record.processIdentity === 'string') return true;
  const { socketPath } = record;
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) return false;
  const socketName =
    process.platform === 'win32' ? `mearl-agent-${record.pid}` : `mearl-agent-${record.pid}.sock`;
  if (basename(socketPath) !== socketName) return false;
  const status = await invokeLocalHost(
    'node_capabilities_status',
    {},
    { socketPath, timeoutSec: 2 },
  );
  return status !== null && typeof status === 'object' && 'installationRevision' in status;
}

function nativeHosts(root: string): DaemonRecord[] {
  const browserHosts = liveRecords(join(root, 'browsers')).filter(
    record => record.transport === 'extension' || record.transport === 'cdp',
  );
  return [
    ...new Map(
      [...browserHosts, ...liveRecords(join(root, 'control'))].map(record => [record.pid, record]),
    ).values(),
  ];
}

function assertOtherRuntimesStopped(root: string): void {
  if (listInstalledProviders().length)
    throw new Error('Registered Providers still use the Mearl data directory');
  if (
    ['providers/live', 'providers/starting'].some(
      directory => liveRecords(join(root, directory)).length,
    )
  )
    throw new Error('Providers are still running. Stop them and rerun the uninstall.');
  if (liveRecords(join(root, 'managed-browsers')).length)
    throw new Error('Managed browsers are still running. Close them and rerun the uninstall.');
  if (liveRecords(join(root, 'connectors')).length)
    throw new Error('Cloud connectors are still running. Stop them and rerun the uninstall.');
}

/** Remove the default Mearl data directory after its runtime owners have stopped. */
export async function cleanupUninstalledRuntime(): Promise<void> {
  const root = join(homedir(), '.mearl');
  const data = lstatSync(root, { throwIfNoEntry: false });
  const removeData = () => {
    const current = lstatSync(root, { throwIfNoEntry: false });
    if (current && (!data || current.dev !== data.dev || current.ino !== data.ino))
      throw new Error('The Mearl data directory changed during uninstall. Rerun the uninstall.');
    if (current?.isDirectory()) {
      assertOtherRuntimesStopped(root);
      if (nativeHosts(root).length)
        throw new Error('A Mearl Native Host started during uninstall. Rerun the uninstall.');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
  if (data?.isDirectory()) {
    assertOtherRuntimesStopped(root);
    for (const record of nativeHosts(root)) await stopNativeHost(record);
  }

  const registry = relative(root, pluginDirectory());
  const usesMearlDirectory =
    registry !== '..' && !registry.startsWith(`..${sep}`) && !isAbsolute(registry);
  if (data?.isDirectory() || !usesMearlDirectory)
    await cleanupPluginRuntime({ removeData, defaultRegistry: join(root, 'plugins') });
  else removeData();
}
