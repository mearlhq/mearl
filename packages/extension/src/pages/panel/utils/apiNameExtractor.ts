import { parseRequestMetadata } from '@mearl/browser-core';
export async function inspectRequest(url: string, body?: unknown) {
  const response = await chrome.runtime.sendMessage({ action: 'requestInspection', data: { url, body } });
  if (!response?.success) throw new Error(response?.error || 'Request inspection unavailable');
  return parseRequestMetadata(response.data);
}
