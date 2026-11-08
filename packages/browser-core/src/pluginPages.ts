import type { PluginExecutionError, PluginExecutionHost } from './pluginExecution.js';

export const PLUGIN_PAGE_LEASE_MS = 30000;

/** Document or access-scope invalidation can cross transports that preserve only a message. */
export function isPluginPageInvalidation(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null;
  const codes = [
    'PLUGIN_PAGE_INVALIDATED',
    'PLUGIN_PAGE_NOT_FOUND',
    'PLUGIN_PAGE_TARGET_CHANGED',
    'DOMAIN_PERMISSION_REQUIRED',
  ];
  const message = typeof value?.message === 'string' ? value.message : '';
  return codes.includes(String(value?.code)) || codes.some(code => message.startsWith(`${code}:`));
}

export function isPluginPageUnavailable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'PLUGIN_PAGE_UNAVAILABLE';
}

export function pluginPageUnavailable(error: unknown): Error {
  return Object.assign(new Error('Plugin page host is temporarily unavailable', { cause: error }), {
    code: 'PLUGIN_PAGE_UNAVAILABLE',
  });
}

/** main/business selectors, Chrome numeric frame IDs, or CDP opaque frame IDs. */
export type PluginPageFrame = string | number;
export type PluginPageOperation =
  | 'attach'
  | 'get'
  | 'list'
  | 'send'
  | 'detach'
  | 'events'
  | 'activation';
export interface PluginPageEventBinding {
  command: string;
  schema: Record<string, unknown>;
  policy?: 'serial' | 'latest' | 'parallel';
  concurrency?: number;
  maxPending?: number;
  executionTimeoutMs?: number;
}
export interface PluginPageRuntime {
  version: 1;
  matches: string[];
  /** Self-contained function expression receiving {input, signal, emit, identity}. */
  code: string;
  initialize?: string;
  events?: Record<string, PluginPageEventBinding>;
}
export interface PluginPageTarget {
  browserSessionId: string;
  tabId: number;
  frameId: string | number;
  documentId: string;
  url: string;
}
export interface PluginPageInstance {
  instanceId: string;
  plugin: string;
  installationId: string;
  revision: string;
  host: PluginExecutionHost;
  target: PluginPageTarget;
  state: 'active' | 'detached' | 'invalidated';
  sequence: number;
  createdAt: number;
  error?: PluginExecutionError;
}
export interface PluginPageEvent {
  sequence: number;
  time: number;
  type: 'received' | 'running' | 'success' | 'error' | 'superseded' | 'navigation' | 'invalidated';
  eventSequence?: number;
  name?: string;
  payload?: unknown;
  taskId?: string;
  error?: PluginExecutionError;
}
export interface PluginPageEvents {
  instance: PluginPageInstance;
  events: PluginPageEvent[];
  nextCursor: number;
  firstAvailableSequence: number;
  gap: boolean;
}
export interface PluginPageActivation {
  plugin: string;
  installationId: string;
  enabled: boolean;
  matches: string[];
  persistence: 'session' | 'persistent';
  frame: PluginPageFrame;
  input: Record<string, unknown>;
}
export interface PluginPageBinding {
  instanceId: string;
  target: PluginPageTarget;
}

const pattern = /^(https?|\*):\/\/(\*|\*\.[a-z0-9.-]+|[a-z0-9.-]+|localhost)(:\d+)?(\/[^#]*)$/i;
const localPattern = /^file:\/\/\/(?:[^/*?#\\]+\/)+(?:\*|[^/*?#\\]+)\.html$/;
export function isPluginPageMatchPattern(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && (pattern.test(value) || localPattern.test(value));
}
export function matchesPluginPageURL(matches: readonly string[], value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'file:') {
    if (url.hostname || !url.pathname.endsWith('.html')) return false;
    url.search = '';
    url.hash = '';
    return matches.some(item => localPattern.test(item) && (item === url.href ||
      (item.endsWith('/*.html') && item.slice(0, item.lastIndexOf('/') + 1) === url.href.slice(0, url.href.lastIndexOf('/') + 1))));
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  return matches.some(item => {
    const match = item.match(pattern);
    if (!match || (match[1] !== '*' && match[1].toLowerCase() + ':' !== url.protocol)) return false;
    const host = match[2].toLowerCase();
    if (
      host !== '*' &&
      host !== url.hostname &&
      !(
        host.startsWith('*.') &&
        (url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)))
      )
    )
      return false;
    if (match[3] && match[3].slice(1) !== (url.port || (url.protocol === 'https:' ? '443' : '80')))
      return false;
    const expression =
      '^' +
      match[4]
        .split('*')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$';
    return new RegExp(expression).test(url.pathname + url.search);
  });
}
export function isPluginPageInstanceId(value: unknown): value is string {
  return typeof value === 'string' && /^pi_[0-9a-f-]{36}$/i.test(value);
}
