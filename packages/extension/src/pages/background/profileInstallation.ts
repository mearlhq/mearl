import { parseProfileSource } from '@mearl/preset/bundles';
import { browserCapabilityRegistry } from './browserCapabilityRegistry';

const page = 'src/pages/options/index.html';
type Installed = Awaited<ReturnType<ReturnType<typeof browserCapabilityRegistry>['installProfile']>>;
const confirmations = new Map<string, {
  source: string;
  begin: () => void;
  resolve: (value: Installed) => void;
  reject: (error: unknown) => void;
}>();

async function hasPermission(source: string) {
  return chrome.permissions.contains({ origins: [`${parseProfileSource(source).origin}/*`] });
}

export async function installProfileFromSettings(source: string, confirmation?: string) {
  const pending = confirmation ? confirmations.get(confirmation) : undefined;
  if (confirmation && pending?.source !== source) throw new Error('Profile installation request has expired');
  if (!(await hasPermission(source))) throw new Error('App profile source permission required');
  pending?.begin();
  try {
    const result = await browserCapabilityRegistry().installProfile(source);
    pending?.resolve(result);
    return result;
  } catch (error) {
    pending?.reject(error);
    throw error;
  }
}

export async function installProfileFromSetup(source: string) {
  if (await hasPermission(source)) return browserCapabilityRegistry().installProfile(source);
  const confirmation = crypto.randomUUID();
  const params = new URLSearchParams({ profileSource: source, profileConfirmation: confirmation });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tabId: number | undefined;
  let closed: (id: number) => void = () => {};
  try {
    const pending = new Promise<Installed>((resolve, reject) => {
      confirmations.set(confirmation, {
        source, resolve, reject,
        begin: () => {
          if (!confirmations.delete(confirmation)) throw new Error('Profile installation request has expired');
          clearTimeout(timer);
          chrome.tabs.onRemoved.removeListener(closed);
        },
      });
      timer = setTimeout(() => reject(new Error('App profile installation confirmation timed out')), 90000);
      closed = id => { if (id === tabId) reject(new Error('App profile installation was cancelled')); };
    });
    chrome.tabs.onRemoved.addListener(closed);
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`${page}?${params}`), active: true });
    tabId = tab.id;
    return await pending;
  } finally {
    confirmations.delete(confirmation);
    clearTimeout(timer);
    chrome.tabs.onRemoved.removeListener(closed);
  }
}
