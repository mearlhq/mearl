import { nativeCapabilities } from './native-capability-services.js';
import { randomUUID } from 'node:crypto';
import { NATIVE_HOST_VERSION } from './version.js';
import { readMearlConfig, writeMearlConfig, type MearlConfig } from './config.js';

const CLIENT_ID_PATTERN = /^\d+\.\d+$/;
const BUILD_CHANNEL = NATIVE_HOST_VERSION === 'unknown' ? 'development' : 'production';

function writeConfig(config: MearlConfig): void {
  try {
    writeMearlConfig(config);
  } catch {
    // best-effort
  }
}

let clientId: string | null = null;

function createClientId(seed: string = randomUUID()): string {
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ code, 3266489917) >>> 0;
  }
  return `${first || 1}.${second || 1}`;
}

function getClientId(): string {
  if (clientId) return clientId;
  const config = readMearlConfig();
  if (config.clientId && CLIENT_ID_PATTERN.test(config.clientId)) {
    clientId = config.clientId;
    return clientId;
  }
  clientId = createClientId(config.clientId);
  writeConfig({ ...config, clientId });
  return clientId;
}

export function setAnalyticsClientId(value: unknown): boolean {
  if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) return false;
  clientId = value;
  return true;
}

export function classifyAnalyticsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout/i.test(message)) return 'timeout';
  if (/permission|not authorized|access denied|forbidden/i.test(message)) {
    return 'permission_denied';
  }
  if (/not found|no matching|does not exist/i.test(message)) return 'not_found';
  if (/not connected|disconnected|unavailable|connection (?:failed|closed)/i.test(message)) {
    return 'unavailable';
  }
  if (/invalid|required|must be|unsupported/i.test(message)) return 'invalid_request';
  return 'execution_error';
}

export function trackAction(
  action: string,
  params?: Record<string, string | number | boolean>,
): void {
  const endpoint = process.env.MEARL_ANALYTICS_ENDPOINT || nativeCapabilities.get('analytics.endpoint')?.();
  if (!endpoint) return;
  const payload = {
    client_id: getClientId(),
    events: [
      {
        name: 'agent_action',
        params: {
          action,
          ...params,
          mearl_version: NATIVE_HOST_VERSION,
          runtime: 'native_host',
          build_channel: BUILD_CHANNEL,
        },
      },
    ],
  };

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}
