/** Optional protocol annotations; the collector retains the original HTTP record. */
export interface RequestMetadata {
  apiName: string;
  namespace?: string;
  isProxy: boolean;
  proxyRequestUrl: string | null;
  environment?: string;
}
export function parseRequestMetadata(value: unknown): RequestMetadata | null {
  if (value === null || value === undefined) return null;
  const metadata = value as RequestMetadata;
  if (typeof value !== 'object' || Array.isArray(value) || metadata.namespace !== undefined && (typeof metadata.namespace !== 'string' || metadata.namespace.length > 256) || typeof metadata.apiName !== 'string' || metadata.apiName.length > 4096 || typeof metadata.isProxy !== 'boolean' || metadata.proxyRequestUrl !== null && typeof metadata.proxyRequestUrl !== 'string' || metadata.environment !== undefined && (typeof metadata.environment !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(metadata.environment))) throw new Error('Invalid request metadata');
  return { ...(metadata.namespace ? { namespace: metadata.namespace } : {}), apiName: metadata.apiName, isProxy: metadata.isProxy, proxyRequestUrl: metadata.proxyRequestUrl, ...(metadata.environment ? { environment: metadata.environment } : {}) };
}
