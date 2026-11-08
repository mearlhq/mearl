import { CapturedRequest } from '../types';

export function resolveRequestVersion(
  request: Pick<CapturedRequest, 'proxyRequestUrl' | 'url' | 'queryString'>,
): string {
  const queryVersion = request.queryString?.find(item => item.name === 'v')?.value;
  if (queryVersion) return queryVersion;

  const urlToParse = request.proxyRequestUrl || request.url;
  const urlVersion = urlToParse?.match(/\/[\w.-]+\/(\d+(?:\.\d+)*)(?:[/?#]|$)/)?.[1];
  return urlVersion || '1.0';
}
