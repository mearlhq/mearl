import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProviderProtocolVersion, MEARL_PROVIDER_PROTOCOL_VERSION } from './protocol.js';
import type { BrowserControlSessionMode } from '@mearl/browser-core';
import {
  isAlive,
  keyedConfigFile,
  claimRecord,
  readRecord,
  removeInvalidRecord,
  removeRecordIfPid,
  writeRecordIfPid,
  type DaemonRecord,
} from '@mearl/daemon-core';

export interface ProviderControlHostRecord extends DaemonRecord {
  socketPath: string;
  token: string;
  ready: boolean;
  protocolVersion: number;
  /** Missing on older hosts, which only support Mearl sessions. */
  controlSessionModes?: readonly BrowserControlSessionMode[];
  enhancementProtocolVersion?: number;
  enhancementNavigationOriginVersion?: number;
  enhancementPreparationVersion?: number;
  enhancementHostEnvironmentVersion?: number;
  /** RPC support only; each read still prepares and validates the accepted App resources. */
  appResourceProtocolVersion?: number;
}

export function assertProviderControlSessionMode(
  host: Pick<ProviderControlHostRecord, 'controlSessionModes'> | null,
  mode: BrowserControlSessionMode = 'mearl',
): void {
  if (mode === 'external' && (
    !Array.isArray(host?.controlSessionModes) || !host.controlSessionModes.includes('external')
  )) {
    throw new Error(
      'CONTROL_SESSION_MODE_UNSUPPORTED: the Provider requires external task control. Update Mearl and restart the Provider control host.',
    );
  }
}

export function providerControlHostFile(): string {
  return keyedConfigFile('control', 'providers');
}

export function providerControlSocketPath(pid: number): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mearl-provider-control-${pid}`
    : join(tmpdir(), `mearl-provider-control-${pid}.sock`);
}

export function readProviderControlHost(): ProviderControlHostRecord | null {
  const record = readRecord<ProviderControlHostRecord>(providerControlHostFile());
  if (!record?.ready || typeof record.socketPath !== 'string' || !isAlive(record.pid)) return null;
  assertProviderProtocolVersion(record.protocolVersion, 'Provider control host');
  return record;
}

let startup: Promise<ProviderControlHostRecord> | undefined;

/** A single host owns Provider sessions across independent CLI and connector processes. */
export function ensureProviderControlHost(timeoutMs = 10_000): Promise<ProviderControlHostRecord> {
  if (startup) return startup;
  const pending = (async () => {
    const file = providerControlHostFile();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = readProviderControlHost();
      if (ready) return ready;
      const previous = readRecord<ProviderControlHostRecord>(file);
      if (!previous || !isAlive(previous.pid)) {
        if (previous) removeRecordIfPid(file, previous.pid);
        else removeInvalidRecord(file);
        const token = randomUUID();
        if (
          claimRecord(file, {
            pid: process.pid,
            socketPath: '',
            token,
            ready: false,
            protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
          })
        ) {
          try {
            const entry = process.env.MEARL_NATIVE_HOST_ENTRY;
            const child = spawn(
              entry ? process.execPath : 'mearl-native-host',
              [...(entry ? [entry] : []), '--provider-control', token],
              { detached: true, stdio: 'ignore', windowsHide: true },
            );
            await new Promise<void>((resolve, reject) => {
              child.once('error', reject);
              child.once('spawn', resolve);
            });
            child.unref();
            if (!child.pid) throw new Error('Provider control host did not report its pid');
            writeRecordIfPid(file, process.pid, {
              pid: child.pid,
              socketPath: providerControlSocketPath(child.pid),
              token,
              ready: false,
              protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
            });
          } catch (error) {
            removeRecordIfPid(file, process.pid);
            throw error;
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Provider control host startup timed out');
  })();
  startup = pending;
  void pending
    .finally(() => {
      if (startup === pending) startup = undefined;
    })
    .catch(() => {});
  return pending;
}
