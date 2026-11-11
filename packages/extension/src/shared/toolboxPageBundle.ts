import type { ToolboxSandboxPage, ToolboxToolOpenResult } from '@mearl/browser-core';
import { requestToolbox } from '../pages/popup/toolboxRequest';

interface CachedToolboxPage {
  hash: string;
  html: string;
}

function cacheKey(toolId: string): string {
  return `toolbox-page:${toolId}`;
}

export interface CachedToolboxTool {
  tool: ToolboxToolOpenResult;
  html: string;
}

export function sameToolboxToolMetadata(
  a: ToolboxToolOpenResult,
  b: ToolboxToolOpenResult,
): boolean {
  // Chrome storage can reorder object keys, including nested page and locale metadata.
  const serialize = (tool: ToolboxToolOpenResult) =>
    JSON.stringify(tool, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map(key => [key, value[key]]),
          )
        : value,
    );
  return serialize(a) === serialize(b);
}

export async function readCachedToolboxTool(toolId: string): Promise<CachedToolboxTool | null> {
  try {
    const key = `toolbox-open:${toolId}`;
    const stored = await chrome.storage.local.get([key, cacheKey(toolId)]);
    const tool = stored[key] as ToolboxToolOpenResult | undefined;
    const bundle = stored[cacheKey(toolId)] as CachedToolboxPage | undefined;
    if (
      tool?.page?.type !== 'sandbox' ||
      typeof tool.title !== 'string' ||
      !bundle ||
      bundle.hash !== tool.page.hash ||
      typeof bundle.html !== 'string' ||
      new TextEncoder().encode(bundle.html).byteLength !== tool.page.size
    )
      return null;
    return { tool, html: bundle.html };
  } catch {
    return null;
  }
}

export async function cacheToolboxTool(toolId: string, tool: ToolboxToolOpenResult): Promise<void> {
  try {
    await chrome.storage.local.set({ [`toolbox-open:${toolId}`]: tool });
  } catch {
    // Cache persistence must not prevent opening a tool.
  }
}

export async function removeCachedToolboxTool(toolId: string): Promise<void> {
  await chrome.storage.local.remove([`toolbox-open:${toolId}`, cacheKey(toolId)]);
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
  const stored = await chrome.storage.local.get(key).catch(() => ({}));
  const cached = (stored as Record<string, CachedToolboxPage>)[key];
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
  try {
    await chrome.storage.local.set({ [key]: { hash: page.hash, html } });
  } catch {
    // The verified page remains usable when storage is full or unavailable.
  }
  return html;
}
