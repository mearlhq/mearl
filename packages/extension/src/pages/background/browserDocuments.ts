import { isExtensionUiSender } from './extensionMessageTrust';

import { BROWSER_DOCUMENT_PROBE } from '../../shared/browserCapabilityMessages';
const prefix = 'mearl-document:';
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

async function probe(token: string): Promise<string | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ target: BROWSER_DOCUMENT_PROBE, token }),
      new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 2000); }),
    ]);
    if (typeof result?.url === 'string' && result.url.startsWith(chrome.runtime.getURL(''))) return result.url;
  } catch { /* A closed document has no receiver. */ }
  finally { clearTimeout(timeout); }
}

/** Chrome supplies documentId for ordinary views; DevTools uses a source-checked private nonce. */
export async function resolveBrowserDocumentSender(sender: chrome.runtime.MessageSender, token: unknown) {
  if (!isExtensionUiSender(sender, chrome.runtime.id)) throw new Error('Extension UI required');
  if (sender.documentId) return sender;
  if (!validToken(token) || await probe(token) !== sender.url) throw new Error('Browser view requires a live extension document');
  return { ...sender, documentId: prefix + token };
}

export async function isBrowserDocumentAlive(documentId: string): Promise<boolean> {
  if (typeof documentId !== 'string' || !documentId) return false;
  if (documentId.startsWith(prefix)) {
    const token = documentId.slice(prefix.length);
    return validToken(token) && !!(await probe(token));
  }
  return (await chrome.runtime.getContexts({ documentIds: [documentId] })).some(context => context.documentId === documentId);
}
