export interface QoderConnectorEndpoint {
  /** User-facing URL retained for daemon identity and lifecycle commands. */
  serverUrl: string;
  scheme: 'qoder';
  pairingCode: string;
  createdAt?: number;
}

const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function parseQoderEndpoint(serverUrl: string, parsed: URL): QoderConnectorEndpoint | null {
  if (
    parsed.hostname !== 'pair' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return null;
  }

  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  if (pathSegments.length !== 1 || !PAIRING_CODE_PATTERN.test(pathSegments[0]!)) return null;

  const allowedParams = new Set(['created']);
  if ([...parsed.searchParams.keys()].some(key => !allowedParams.has(key))) return null;

  const createdValues = parsed.searchParams.getAll('created');
  if (createdValues.length > 1) return null;
  const createdValue = createdValues[0] ?? null;
  if (createdValue !== null && !/^\d{13}$/.test(createdValue)) return null;
  const createdAt = createdValue === null ? undefined : Number(createdValue);
  if (createdAt !== undefined && (!Number.isSafeInteger(createdAt) || createdAt <= 0)) return null;

  return {
    serverUrl,
    scheme: 'qoder',
    pairingCode: pathSegments[0]!,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

export function requireQoderEndpoint(serverUrl: string): QoderConnectorEndpoint {
  const parsed = new URL(serverUrl);
  const endpoint = parsed.protocol === 'qoder:' ? parseQoderEndpoint(serverUrl, parsed) : null;
  if (!endpoint) throw new Error('Invalid qoder://pair/<code> endpoint');
  return endpoint;
}
