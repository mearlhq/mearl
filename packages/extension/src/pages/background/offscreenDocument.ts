import { BROWSER_CONTROLLER_OFFSCREEN_TARGET } from '../../shared/browserCapabilityMessages';
const DOCUMENT_PATH = 'src/pages/offscreen/index.html';
let users = 0;
let transition: Promise<unknown> = Promise.resolve();

function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const next = transition.then(operation, operation);
  transition = next.catch(() => {});
  return next;
}

/** SSO and installed browser services share Chrome's single offscreen document. */
export async function withOffscreenDocument<T>(operation: () => Promise<T>): Promise<T> {
  users++;
  try {
    await exclusive(async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: DOCUMENT_PATH,
        reasons: ['IFRAME_SCRIPTING' as chrome.offscreen.Reason],
        justification: 'Run extension iframe operations without opening a user tab.',
      });
    });
    return await operation();
  } finally {
    users--;
    await exclusive(async () => {
      if (users !== 0 || !(await chrome.offscreen.hasDocument())) return;
      // The worker may have restarted while resident controllers kept their state.
      const resident = await chrome.runtime
        .sendMessage({ target: BROWSER_CONTROLLER_OFFSCREEN_TARGET, operation: 'held' })
        .catch(() => undefined);
      if (resident?.held === true) return;
      if (resident?.held !== false) return;
      await chrome.offscreen.closeDocument().catch(() => {});
    }).catch(() => {});
  }
}
