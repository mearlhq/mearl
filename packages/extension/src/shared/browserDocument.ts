import { BROWSER_DOCUMENT_PROBE } from './browserCapabilityMessages';

/** A per-document proof for extension surfaces whose MessageSender omits documentId. */
export const browserDocumentToken = crypto.randomUUID();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== BROWSER_DOCUMENT_PROBE || message.token !== browserDocumentToken || sender.id !== chrome.runtime.id) return;
  sendResponse({ url: location.href });
});

export function sendBrowserDocumentMessage(message: Record<string, unknown>) {
  return chrome.runtime.sendMessage({ ...message, documentToken: browserDocumentToken });
}
