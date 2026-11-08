import type { ToolboxSandboxPage } from '@mearl/browser-core';
import { requestToolbox } from '../pages/popup/toolboxRequest';

interface CachedToolboxPage {
  hash: string;
  html: string;
}

function cacheKey(toolId: string): string {
  return `toolbox-page:${toolId}`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifiedHtml(bytes: Uint8Array, page: ToolboxSandboxPage): Promise<string> {
  if (bytes.byteLength !== page.size) throw new Error('Plugin page size does not match metadata');
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  if (hex(digest) !== page.hash) throw new Error('Plugin page integrity check failed');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function loadToolboxPageBundle(
  toolId: string,
  page: ToolboxSandboxPage,
): Promise<string> {
  const key = cacheKey(toolId);
  const cached = (await chrome.storage.local.get(key))[key] as CachedToolboxPage | undefined;
  if (cached && cached.hash === page.hash && typeof cached.html === 'string') {
    const bytes = new TextEncoder().encode(cached.html);
    if (bytes.byteLength === page.size) return cached.html;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (let index = 0; index < page.chunks; index += 1) {
    const chunk = await requestToolbox('toolbox_tool_page_chunk', {
      id: toolId,
      hash: page.hash,
      index,
    });
    if (chunk.hash !== page.hash || chunk.index !== index || chunk.total !== page.chunks) {
      throw new Error('Plugin page changed while loading');
    }
    const bytes = decodeBase64(chunk.data);
    chunks.push(bytes);
    totalBytes += bytes.byteLength;
  }

  const content = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const html = await verifiedHtml(content, page);
  await chrome.storage.local.set({ [key]: { hash: page.hash, html } });
  return html;
}
