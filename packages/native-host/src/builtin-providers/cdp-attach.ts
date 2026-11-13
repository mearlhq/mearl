import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';
import { hashKey } from '@mearl/daemon-core';
import {
  MEARL_PROVIDER_PROTOCOL_VERSION,
  createProviderRuntime,
  type ProviderBrowser,
  type ProviderContext,
  type ProviderRuntime,
} from '@mearl/provider';
import {
  listRegisteredBrowsers,
  retireUnreachableBrowserRecord,
  type BrowserRecord,
} from '../browser-registry.js';
import { requestBrowserSocket } from '../browser-socket-request.js';
import { chromeUserDataDir, readDevToolsActivePort } from '../cdp-backend/discover.js';
import { acquireLaunchLock, validateName } from '../managed-browser.js';
import { NATIVE_HOST_VERSION } from '../version.js';

export const CDP_PROVIDER = {
  providerId: 'cdp',
  name: 'CDP',
  version: NATIVE_HOST_VERSION,
  protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
  builtin: true,
};

interface AttachOptions {
  name?: string;
  port?: number;
  userDataDir?: string;
  endpointFile?: string;
  headless?: boolean;
}

function canConnectInstanceSocket(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(true), 300).unref();
    const finish = (reachable: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED'),
    );
  });
}

function connectedCdpBrowsers(): BrowserRecord[] {
  return listRegisteredBrowsers().filter(
    browser => browser.transport === 'cdp' && browser.provider?.id === CDP_PROVIDER.providerId,
  );
}

function attachedBrowser(record: BrowserRecord): ProviderBrowser {
  return {
    browserId: record.browserId,
    name: record.browserName,
    status: 'connected',
    control: { kind: 'host', transport: 'cdp', browserId: record.browserId },
    ownership: 'attached',
    persistence: 'ephemeral',
    operations: ['detach'],
    details: record.details,
  };
}

async function attach(
  options: AttachOptions,
  nativeHostScript: string,
  socketPathForPid: (pid: number) => string,
  context: ProviderContext,
): Promise<ProviderBrowser> {
  const { port, headless } = options;
  if (port !== undefined && !Number.isInteger(port)) throw new Error('port must be an integer');
  if (options.endpointFile && (options.userDataDir || port !== undefined))
    throw new Error('endpointFile cannot be combined with port or userDataDir');
  const endpointFile = options.endpointFile && resolve(options.endpointFile);
  const userDataDir = options.userDataDir && resolve(options.userDataDir);
  const discoveryDir =
    !endpointFile && (userDataDir || port === undefined)
      ? (userDataDir ?? chromeUserDataDir())
      : undefined;
  const activePort = discoveryDir ? readDevToolsActivePort(discoveryDir) : null;
  if (userDataDir && port === undefined && !activePort)
    throw new Error(
      `Could not read DevToolsActivePort from ${userDataDir}. Enable remote debugging for that Chrome profile.`,
    );
  if (activePort && port !== undefined && activePort.port !== port)
    throw new Error(
      `The Chrome profile uses CDP port ${activePort.port}, but port ${port} was requested`,
    );
  const effectivePort = activePort?.port ?? port ?? 9222;
  const browserId = endpointFile ? `cdp:file:${hashKey(endpointFile)}` : `cdp:${effectivePort}`;
  const name =
    options.name === undefined ? (port ? `CDP ${port}` : 'CDP') : validateName(options.name);
  const unlock = acquireLaunchLock(browserId);
  try {
    await retireUnreachableBrowserRecord(browserId, canConnectInstanceSocket);
    const existing = connectedCdpBrowsers().find(browser => browser.browserId === browserId);
    if (existing) return attachedBrowser(existing);

    const args = [
      nativeHostScript,
      '--daemon',
      '--attach-cdp',
      '--browser-id',
      browserId,
      '--browser-name',
      name,
      ...(endpointFile ? [] : ['--cdp-port', String(effectivePort)]),
      ...(activePort && discoveryDir ? ['--cdp-user-data-dir', discoveryDir] : []),
      ...(endpointFile ? ['--cdp-endpoint-file', endpointFile] : []),
      ...(headless ? ['--browser-headless'] : []),
    ];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      child.unref();
      if (!child.pid) throw new Error('CDP host did not report its process id');
      const socketPath = socketPathForPid(child.pid);
      const deadline = Math.min(context.deadline ?? Infinity, Date.now() + 60_000);
      const startupDeadline = Math.min(deadline, Date.now() + 10_000);
      while (true) {
        try {
          await requestBrowserSocket(
            socketPath,
            '__cdp_attach',
            {},
            NATIVE_HOST_VERSION,
            60_000,
            undefined,
            undefined,
            { deadline },
          );
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            child.exitCode !== null ||
            child.signalCode !== null ||
            Date.now() >= startupDeadline ||
            (code !== 'ENOENT' && code !== 'ECONNREFUSED')
          )
            throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      const connected = connectedCdpBrowsers().find(browser => browser.browserId === browserId);
      if (!connected) throw new Error(`CDP browser did not register: ${browserId}`);
      if (connected.pid !== child.pid) child.kill();
      return attachedBrowser(connected);
    } catch (error) {
      child.kill();
      throw error;
    }
  } finally {
    unlock();
  }
}

export function createCdpAttachProvider(
  nativeHostScript: string,
  socketPathForPid: (pid: number) => string,
): ProviderRuntime {
  return createProviderRuntime({
    descriptor: CDP_PROVIDER,
    browserType: {
      name: 'CDP',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          port: { type: 'number', minimum: 1, maximum: 65_535 },
          userDataDir: { type: 'string', minLength: 1 },
          endpointFile: { type: 'string', minLength: 1, formHidden: true },
          headless: { type: 'boolean', default: false },
        },
      },
    },
    listBrowsers: () => connectedCdpBrowsers().map(attachedBrowser),
    launch: (options, context) => attach(options, nativeHostScript, socketPathForPid, context),
    close: async () => {
      throw new Error('Use browser_release to detach from the CDP browser');
    },
    detach: async ({ browserId }, context) => {
      const record = connectedCdpBrowsers().find(browser => browser.browserId === browserId);
      if (!record) throw new Error(`CDP browser not found: ${browserId}`);
      return requestBrowserSocket(
        record.socketPath,
        'browser_release',
        {},
        NATIVE_HOST_VERSION,
        undefined,
        undefined,
        undefined,
        { deadline: context.deadline, controlSource: context.controlSource },
      );
    },
  });
}
