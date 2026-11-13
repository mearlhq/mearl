import net from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readRecord, writeRecordIfPid, removeRecordIfPid } from '@mearl/daemon-core';
import {
  providerControlHostFile,
  providerControlSocketPath,
  type ProviderControlHostRecord,
} from '@mearl/provider/host';
import { browserConnectionIdentity, listRegisteredBrowsers } from './browser-registry.js';
import { requestBrowserSocket } from './browser-socket-request.js';
import { ProviderControlService } from './provider-control.js';
import { ProviderEnhancementService } from './provider-enhancements.js';
import {
  BROWSER_ENHANCEMENT_PROTOCOL_VERSION,
  BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION,
  BROWSER_ENHANCEMENT_PREPARATION_VERSION,
  BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION,
  PROVIDER_APP_RESOURCE_PROTOCOL_VERSION,
} from '@mearl/browser-core';
import { acceptedAppResources, ProviderAppResourceService } from './provider-app-resources.js';
import { Utf8LineBuffer } from './socketLines.js';
import { NATIVE_HOST_VERSION } from './version.js';
import { assertProviderProtocolVersion, MEARL_PROVIDER_PROTOCOL_VERSION } from '@mearl/provider';
import { providerRequestTimeoutMs } from './provider-request-timeout.js';

export async function runProviderControlHost(token: string): Promise<void> {
  const file = providerControlHostFile();
  const owner = readRecord<ProviderControlHostRecord>(file);
  if (!owner || owner.token !== token)
    throw new Error('Provider control host startup ownership was lost');
  const socketPath = providerControlSocketPath(process.pid);
  if (
    !writeRecordIfPid(file, owner.pid, {
      pid: process.pid,
      socketPath,
      token,
      ready: false,
      protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
    })
  )
    throw new Error('Provider control host startup ownership was lost');
  const connections = new Set<net.Socket>();
  const service = new ProviderControlService({
    browsers: listRegisteredBrowsers,
    request: (browser, action, data, origin, host, deadline) =>
      requestBrowserSocket(
        browser.socketPath,
        action,
        data,
        NATIVE_HOST_VERSION,
        providerRequestTimeoutMs(action, data, deadline),
        browser.providerBrowserId,
        host,
        { controlSource: origin, deadline },
      ),
    notify: () => {
      for (const browser of listRegisteredBrowsers()) {
        if (browser.transport === 'extension') {
          void requestBrowserSocket(
            browser.socketPath,
            'provider_control_sessions_changed',
            {},
            NATIVE_HOST_VERSION,
            5000,
          ).catch(() => {});
        }
      }
    },
  });
  const enhancements = new ProviderEnhancementService({
    browsers: listRegisteredBrowsers,
    request: (browser, action, data, deadline) =>
      requestBrowserSocket(
        browser.socketPath,
        action,
        data,
        NATIVE_HOST_VERSION,
        providerRequestTimeoutMs(action, data, deadline),
        browser.providerBrowserId,
        undefined,
        { deadline },
      ),
    enhance: (browser, provider, data, deadline, providerTabId) =>
      requestBrowserSocket(
        browser.socketPath,
        '__provider_enhancement',
        data,
        NATIVE_HOST_VERSION,
        providerRequestTimeoutMs(
          data.operation === 'invoke' ? data.action : 'page_frames',
          data,
          deadline,
        ),
        undefined,
        undefined,
        {
          providerTarget: provider.browserId,
          providerControlToken: token,
          providerSourceIdentity: browserConnectionIdentity(provider),
          providerPageId: providerTabId,
          deadline,
        },
      ),
  });
  const appResources = new ProviderAppResourceService({
    browsers: listRegisteredBrowsers,
    snapshot: acceptedAppResources,
    verify: (browser, tabId, deadline) =>
      requestBrowserSocket(
        browser.socketPath,
        '__provider_enhancement_target',
        { tabId },
        NATIVE_HOST_VERSION,
        providerRequestTimeoutMs('page_frames', {}, deadline),
        browser.providerBrowserId,
        undefined,
        { deadline },
      ),
  });
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => connections.delete(socket));
    const lines = new Utf8LineBuffer(16 * 1024 * 1024);
    socket.on('data', chunk => {
      const result = lines.push(chunk);
      if (result.overflow) return socket.destroy();
      for (const line of result.lines) void handle(line, socket);
    });
  });

  async function handle(line: string, socket: net.Socket) {
    let id = '';
    try {
      const request = JSON.parse(line);
      id = typeof request.id === 'string' ? request.id : randomUUID();
      assertProviderProtocolVersion(request.protocolVersion, 'Provider control client');
      const data = request.data ?? {};
      let result: unknown;
      if (request.action === '__control_session_resolve') {
        result = { session: service.find(data.sessionId) ?? null };
      } else if (request.action === 'session_list') {
        if (request.controlSessionId !== undefined)
          throw new Error('session_list does not accept a session override');
        result = { sessions: service.list() };
      } else if (request.action === '__provider_enhancement') {
        if (
          typeof request.providerTarget !== 'string' ||
          request.controlSessionId !== undefined ||
          (request.transport !== undefined && request.transport !== 'provider')
        )
          throw new Error(
            'Provider enhancements require an external browser without a Mearl session',
          );
        result = await enhancements.invoke(request.providerTarget, data, request.deadline);
      } else if (request.action === '__provider_app_resources') {
        if (
          typeof request.providerTarget !== 'string' ||
          request.controlSource !== 'local' ||
          request.controlSessionId !== undefined ||
          (request.transport !== undefined && request.transport !== 'provider')
        )
          throw new Error('App resources require a local external browser without a Mearl session');
        result = await appResources.invoke(request.providerTarget, data, request.deadline);
      } else if (request.action === 'browser_sessions') {
        if (data.operation === 'list') result = { sessions: service.list() };
        else {
          if (
            !['handoff', 'resume', 'release'].includes(data.operation) ||
            typeof data.sessionId !== 'string' ||
            !data.sessionId
          )
            throw new Error('Invalid browser session operation');
          result = { session: await service.userControl(data.sessionId, data.operation) };
        }
      } else {
        if (typeof request.providerTarget !== 'string' || typeof request.action !== 'string')
          throw new Error('Provider browser and action are required');
        if (!data || typeof data !== 'object' || Array.isArray(data))
          throw new Error('Invalid action payload');
        if (request.transport && request.transport !== 'provider')
          throw new Error('A session cannot change transport');
        result = await service.invoke(
          request.providerTarget,
          request.action,
          data,
          request.controlSessionId,
          request.controlSource ?? 'local',
          request.host,
          request.deadline,
        );
      }
      if (!socket.destroyed)
        socket.write(JSON.stringify({ id, success: true, data: result }) + '\n');
    } catch (error) {
      if (!socket.destroyed)
        socket.write(
          JSON.stringify({
            id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }) + '\n',
        );
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
    if (
      !writeRecordIfPid(file, process.pid, {
        pid: process.pid,
        socketPath,
        token,
        ready: true,
        protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        controlSessionModes: ['mearl', 'external'],
        enhancementProtocolVersion: BROWSER_ENHANCEMENT_PROTOCOL_VERSION,
        enhancementNavigationOriginVersion: BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION,
        enhancementPreparationVersion: BROWSER_ENHANCEMENT_PREPARATION_VERSION,
        enhancementHostEnvironmentVersion: BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION,
        appResourceProtocolVersion: PROVIDER_APP_RESOURCE_PROTOCOL_VERSION,
      })
    )
      throw new Error('Provider control host startup ownership was lost');
    await new Promise<void>(resolve => {
      const stop = () => {
        removeRecordIfPid(file, process.pid);
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    });
  } finally {
    removeRecordIfPid(file, process.pid);
    for (const socket of connections) socket.destroy();
    server.close();
    if (process.platform !== 'win32') rmSync(socketPath, { force: true });
    await service.dispose();
  }
}
