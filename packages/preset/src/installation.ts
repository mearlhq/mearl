export interface InstallationGuide {
  url: string;
}
export interface InstallationPreset {
  label: string;
  source: string;
  origins: string[];
}
export interface InstallationConfig {
  schemaVersion: 1;
  guide?: InstallationGuide;
  presets?: Record<string, InstallationPreset>;
}

function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  ) {
    throw new Error('Invalid installation configuration');
  }
  return value as Record<string, unknown>;
}

function httpsUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid installation URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Invalid installation URL');
  return url;
}

/** One validated catalog is used by the website and extension; parameters cannot add install sources. */
export function parseInstallationConfig(value: unknown, publicOrigin: string): InstallationConfig {
  const input = record(value, ['schemaVersion', 'guide', 'presets']);
  if (input.schemaVersion !== 1) throw new Error('Invalid installation schema');
  const result: InstallationConfig = { schemaVersion: 1 };
  if (input.guide !== undefined) {
    const guide = record(input.guide, ['url']);
    const url = httpsUrl(guide.url);
    if (url.origin === publicOrigin) throw new Error('Invalid guide URL');
    result.guide = { url: url.href };
  }
  if (input.presets !== undefined) {
    if (
      !result.guide ||
      !input.presets ||
      typeof input.presets !== 'object' ||
      Array.isArray(input.presets)
    )
      throw new Error('A preset catalog requires its guide');
    const entries = Object.entries(input.presets);
    if (entries.length > 32) throw new Error('Installation catalog exceeds 32 presets');
    result.presets = Object.fromEntries(
      entries.map(([id, value]) => {
        if (!/^[a-z][a-z0-9-]{0,79}$/.test(id)) throw new Error('Invalid installation preset ID');
        const entry = record(value, ['label', 'source', 'origins']);
        if (
          typeof entry.label !== 'string' ||
          !entry.label.trim() ||
          entry.label.length > 120 ||
          /[\u0000-\u001f\u007f]/.test(entry.label)
        )
          throw new Error('Invalid preset label');
        const source = httpsUrl(entry.source).href;
        if (!Array.isArray(entry.origins) || entry.origins.length > 64)
          throw new Error('Expected preset permission origins');
        const origins = [
          ...new Set([
            `${new URL(source).origin}/*`,
            ...entry.origins.map(validateInstallationOrigin),
          ]),
        ];
        if (origins.length > 64)
          throw new Error('Installation permission origins exceed 64 scopes');
        return [id, { label: entry.label, source, origins }];
      }),
    );
  }
  return result;
}

/** Explicit host scopes retain their selected schemes; download sources remain HTTPS. */
export function validateInstallationOrigin(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^(https?|\*):\/\//.test(value) ||
    !value.endsWith('/*')
  )
    throw new Error('Invalid installation permission origin');
  const scheme = value.slice(0, value.indexOf(':'));
  const wildcard = /^(?:https?|\*):\/\/\*\./.test(value);
  const normalized = value.replace(/^\*:/, 'https:').replace(/^(https?:\/\/)\*\./, '$1');
  const url = new URL(normalized);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.hostname.includes('*') ||
    url.pathname !== '/*' ||
    url.search ||
    !url.hostname ||
    (wildcard && !url.hostname.includes('.'))
  )
    throw new Error('Invalid installation permission origin');
  return `${scheme}://${wildcard ? '*.' : ''}${url.host}/*`;
}

/** Match both scheme and host against a catalog scope before loading a resource. */
export function matchesInstallationOrigin(scope: string, target: URL): boolean {
  const value = validateInstallationOrigin(scope);
  const scheme = value.slice(0, value.indexOf(':'));
  if (
    scheme === '*'
      ? !['http:', 'https:'].includes(target.protocol)
      : `${scheme}:` !== target.protocol
  )
    return false;
  const wildcard = /^(?:https?|\*):\/\/\*\./.test(value);
  const origin = new URL(value.replace(/^\*:/, 'https:').replace(/^(https?:\/\/)\*\./, '$1'));
  return (
    (!origin.port || origin.port === target.port) &&
    (target.hostname === origin.hostname ||
      (wildcard && target.hostname.endsWith(`.${origin.hostname}`)))
  );
}

export const INSTALLATION_CONFIG_MAX_BYTES = 65_536;

export async function readInstallationJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > INSTALLATION_CONFIG_MAX_BYTES)
    throw new Error('Invalid installation response size limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing installation response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('Installation response is too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function loadInstallationConfig(
  url: string | URL,
  publicOrigin: string,
  signal?: AbortSignal,
): Promise<InstallationConfig> {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    throw new Error('Installation configuration unavailable');
  return parseInstallationConfig(
    await readInstallationJson(response, INSTALLATION_CONFIG_MAX_BYTES),
    publicOrigin,
  );
}

export const PRESET_UPDATE_INTERVAL_MS = 12 * 60 * 60_000;
export const PRESET_UPDATE_RETRY_MS = 60 * 60_000;

export function trustedInstallationPreset(
  config: InstallationConfig,
  id: string | undefined,
  source: string | undefined,
): InstallationPreset | undefined {
  return id &&
    source &&
    Object.hasOwn(config.presets ?? {}, id) &&
    config.presets![id].source === source
    ? config.presets![id]
    : undefined;
}

/** An exact scope can be covered by a broader catalog scope, never the reverse. */
export function installationOriginCovered(origin: string, scopes: readonly string[]): boolean {
  const target = validateInstallationOrigin(origin);
  const wildcard = /^(?:https?|\*):\/\/\*\./.test(target);
  const schemes = target.startsWith('*:')
    ? ['http:', 'https:']
    : [target.slice(0, target.indexOf(':') + 1)];
  return scopes.some(scope => {
    const candidate = validateInstallationOrigin(scope);
    if (wildcard && !/^(?:https?|\*):\/\/\*\./.test(candidate)) return false;
    const base = target.replace(/^\*:/, 'https:').replace(/^(https?:\/\/)\*\./, '$1');
    return schemes.every(scheme => {
      const url = new URL(base);
      url.protocol = scheme;
      return matchesInstallationOrigin(candidate, url);
    });
  });
}
