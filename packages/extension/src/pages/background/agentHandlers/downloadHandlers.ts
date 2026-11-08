import type { PageDownloadParams } from '@mearl/browser-core';

let captureActive = false;

/** Capture only downloads attributable to this page or an explicitly expected URL. */
export async function capturePageDownload(
  data: PageDownloadParams,
  trigger: () => Promise<unknown>,
) {
  if (captureActive) throw new Error('DOWNLOAD_CAPTURE_BUSY');
  if (!data.trigger || typeof data.trigger !== 'object')
    throw new Error('page_download requires a click trigger');
  const timeout = data.timeout ?? 30000;
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300000)
    throw new Error('Invalid download timeout');
  const tab = await chrome.tabs.get(data.tabId);
  captureActive = true;
  let downloadId: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (file: chrome.downloads.DownloadItem) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<chrome.downloads.DownloadItem>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void completion.catch(() => {});
  const check = async (id: number) => {
    try {
      const [file] = await chrome.downloads.search({ id });
      if (file?.state === 'complete') resolve(file);
      else if (file?.state === 'interrupted')
        reject(new Error(`DOWNLOAD_INTERRUPTED: ${file.error}`));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const created = (item: chrome.downloads.DownloadItem) => {
    const matches = data.url ? item.url === data.url : !!item.referrer && item.referrer === tab.url;
    if (!matches) return;
    if (downloadId !== undefined) {
      reject(
        new Error(
          'DOWNLOAD_CAPTURE_AMBIGUOUS: multiple matching downloads; inspect before retrying',
        ),
      );
      return;
    }
    downloadId = item.id;
    void check(item.id);
  };
  const changed = (delta: chrome.downloads.DownloadDelta) => {
    if (delta.id === downloadId) void check(delta.id);
  };
  chrome.downloads.onCreated.addListener(created);
  chrome.downloads.onChanged.addListener(changed);
  try {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            'DOWNLOAD_CAPTURE_UNCERTAIN: trigger may have succeeded; inspect downloads before retrying',
          ),
        ),
      timeout,
    );
    const action = await trigger();
    const file = await completion;
    if (!file.filename) throw new Error('Downloaded file has no browser-host path');
    return { filename: file.filename.split(/[\\/]/).pop()!, filePath: file.filename, action };
  } finally {
    if (timer) clearTimeout(timer);
    chrome.downloads.onCreated.removeListener(created);
    chrome.downloads.onChanged.removeListener(changed);
    captureActive = false;
  }
}
