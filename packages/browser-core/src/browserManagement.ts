import type { BrowserManageParams, SessionManageParams } from './browserActionProtocol.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a management payload object');
  return value as Record<string, unknown>;
}

function allow(data: Record<string, unknown>, keys: string[]) {
  const extra = Object.keys(data).find(key => key !== 'operation' && !keys.includes(key));
  if (extra) throw new Error(`${extra} is not valid for operation "${data.operation}"`);
}

export function parseBrowserManageParams(value: unknown): BrowserManageParams {
  const data = record(value);
  switch (data.operation) {
    case 'launch':
      allow(data, [
        'provider',
        'providerOptions',
        'name',
        'headless',
        'userAgentMode',
        'persistent',
        'executablePath',
        'url',
        'copyCookieDomains',
      ]);
      break;
    case 'attach':
      allow(data, ['provider', 'providerOptions']);
      if (typeof data.provider !== 'string' || !data.provider.trim())
        throw new Error('operation "attach" requires a provider');
      break;
    case 'close':
      allow(data, ['deleteProfile']);
      if (data.deleteProfile !== undefined && typeof data.deleteProfile !== 'boolean')
        throw new Error('deleteProfile must be a boolean');
      break;
    case 'detach':
    case 'release':
      allow(data, []);
      break;
    default:
      throw new Error('browser_manage requires launch, attach, detach, close or release');
  }
  if (data.provider !== undefined && (typeof data.provider !== 'string' || !data.provider.trim()))
    throw new Error('provider must be a nonempty string');
  if (data.providerOptions !== undefined) record(data.providerOptions);
  return data as BrowserManageParams;
}

export function parseSessionManageParams(value: unknown): SessionManageParams {
  const data = record(value);
  switch (data.operation) {
    case 'new':
      allow(data, []);
      break;
    case 'handoff':
      allow(data, ['sessionId', 'reason']);
      if (data.reason !== undefined && typeof data.reason !== 'string')
        throw new Error('reason must be a string');
      break;
    case 'resume':
      allow(data, ['sessionId']);
      break;
    case 'end':
      allow(data, [
        'sessionId',
        'closeCreatedTabs',
        'preserveEnvironment',
        'keepTabIds',
        'keepArtifactIds',
      ]);
      for (const key of ['closeCreatedTabs', 'preserveEnvironment']) {
        if (data[key] !== undefined && typeof data[key] !== 'boolean')
          throw new Error(`${key} must be a boolean`);
      }
      if (
        data.keepTabIds !== undefined &&
        (!Array.isArray(data.keepTabIds) ||
          data.keepTabIds.some(id => !Number.isSafeInteger(id) || id < 0) ||
          new Set(data.keepTabIds).size !== data.keepTabIds.length)
      )
        throw new Error('keepTabIds must contain unique nonnegative integer tab IDs');
      if (
        data.keepArtifactIds !== undefined &&
        (!Array.isArray(data.keepArtifactIds) ||
          data.keepArtifactIds.some(id => typeof id !== 'string' || !id))
      )
        throw new Error('keepArtifactIds must contain nonempty strings');
      break;
    default:
      throw new Error('session_manage requires new, handoff, resume or end');
  }
  if (
    data.sessionId !== undefined &&
    (typeof data.sessionId !== 'string' || !/^s_[A-Za-z0-9_-]{8}$/.test(data.sessionId))
  )
    throw new Error('Invalid session id; use session.sessionId');
  return data as SessionManageParams;
}

export function resolveSessionManageId(
  command: SessionManageParams,
  transportId?: string,
): string | undefined {
  if (command.operation === 'new') return transportId;
  if (command.sessionId && transportId && command.sessionId !== transportId)
    throw new Error('Conflicting session IDs');
  return command.sessionId ?? transportId;
}
