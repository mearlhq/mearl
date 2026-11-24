import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDeviceShellNavigation,
  getDirectDeviceShellNavigationUrl,
  recordDeviceShellNavigation,
} from '../deviceShellNavigation';

const url = 'https://example.test/results?page=2';
const doc = { documentId: 'current', url };
const commit: chrome.webNavigation.WebNavigationTransitionCallbackDetails = {
  ...doc,
  tabId: 7,
  frameId: 0,
  frameType: 'outermost_frame',
  documentLifecycle: 'active',
  processId: 1,
  timeStamp: 1,
  transitionType: 'link',
  transitionQualifiers: [],
};
const getFrame = vi.fn();
const records: Record<string, unknown> = {};

beforeEach(() => {
  for (const key of Object.keys(records)) delete records[key];
  getFrame.mockReset().mockResolvedValue(doc);
  chrome.webNavigation.getFrame = getFrame;
  chrome.storage.session = {
    get: vi.fn(async (key: string) => ({ [key]: records[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(records, items);
    }),
    remove: vi.fn(async (key: string) => {
      delete records[key];
    }),
  } as unknown as typeof chrome.storage.session;
});

describe('device shell navigation', () => {
  it('requires the same current document and URL as the direct visit', async () => {
    await recordDeviceShellNavigation(commit);
    await expect(getDirectDeviceShellNavigationUrl(7)).resolves.toBe(url);

    getFrame.mockResolvedValueOnce({ ...doc, documentId: 'another' });
    await expect(getDirectDeviceShellNavigationUrl(7)).resolves.toBeUndefined();
    getFrame.mockResolvedValueOnce({ ...doc, url: `${url}&next=1` });
    await expect(getDirectDeviceShellNavigationUrl(7)).resolves.toBeUndefined();

    await clearDeviceShellNavigation(7);
    await expect(getDirectDeviceShellNavigationUrl(7)).resolves.toBeUndefined();
  });

  it.each([
    { transitionType: 'form_submit' },
    { transitionQualifiers: ['server_redirect'] },
    { transitionQualifiers: ['client_redirect'] },
    { transitionQualifiers: ['forward_back'] },
  ] as const)('keeps this navigation in the top frame (%j)', async change => {
    await recordDeviceShellNavigation(commit);
    await recordDeviceShellNavigation({
      ...commit,
      ...change,
    } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await expect(getDirectDeviceShellNavigationUrl(7)).resolves.toBeUndefined();
  });
});
