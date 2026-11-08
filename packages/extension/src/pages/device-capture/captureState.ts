import type { ResponseOverride } from '../panel/types';
import type { ConnectionState } from './platforms/types';
import type { CaptureProxyConfig } from '../panel/utils/captureProxy';

export interface CaptureChannelState {
  label: string;
  supportsModify: boolean;
  connection: Omit<ConnectionState, 'reconnect' | 'disconnect'>;
  overrides: Array<[string, ResponseOverride]>;
  onlineMocks?: string[];
}
export interface CaptureState {
  channels: Record<string, CaptureChannelState>;
  proxy: { activeProxy: CaptureProxyConfig | null; loading: boolean; synced: boolean; storageReady: boolean; sseUrl: string };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 512;

/** Controller snapshots carry labels and behavior for their accepted implementation. */
export function parseCaptureState(input: unknown): CaptureState {
  if (!record(input) || !record(input.channels) || Object.keys(input.channels).length > 16 || !record(input.proxy)) throw new Error('Invalid capture state');
  for (const [id, value] of Object.entries(input.channels)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !record(value) || !text(value.label) || !value.label || typeof value.supportsModify !== 'boolean' || !record(value.connection) || !Array.isArray(value.overrides) || value.overrides.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !record(entry[1])) || value.onlineMocks !== undefined && (!Array.isArray(value.onlineMocks) || value.onlineMocks.some(url => typeof url !== 'string'))) throw new Error('Invalid capture channel');
    const connection = value.connection;
    if (!['idle', 'connecting', 'connected', 'error'].includes(String(connection.status)) || !['idle', 'waiting', 'active'].includes(String(connection.upstream)) || connection.errorMessage !== undefined && typeof connection.errorMessage !== 'string' || !record(connection.statusText) || !['connecting', 'active', 'idle'].every(key => text((connection.statusText as Record<string, unknown>)[key]))) throw new Error('Invalid capture connection');
  }
  const proxy = input.proxy;
  if (!['loading', 'synced', 'storageReady'].every(key => typeof proxy[key] === 'boolean') || typeof proxy.sseUrl !== 'string' || proxy.activeProxy !== null && (!record(proxy.activeProxy) || !text(proxy.activeProxy.name) || !proxy.activeProxy.name)) throw new Error('Invalid capture proxy');
  return input as unknown as CaptureState;
}
