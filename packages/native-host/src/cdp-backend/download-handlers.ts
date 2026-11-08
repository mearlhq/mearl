import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import type { PageDownloadParams } from '@mearl/browser-core';
import type { CdpSession } from './cdp-session.js';

const captures = new WeakSet<CdpSession>();

export async function captureCdpDownload(
  session: CdpSession,
  data: PageDownloadParams,
  isolated: boolean,
  trigger: () => Promise<unknown>,
) {
  if (captures.has(session)) throw new Error('DOWNLOAD_CAPTURE_BUSY');
  const timeout = data.timeout ?? 30000;
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300000 || !data.trigger)
    throw new Error('Invalid download request');
  const page = await session.getPageSession(data.tabId);
  const tree = await page.client.sendCommand('Page.getFrameTree');
  const frames = new Set<string>();
  const visit = (node: any) => {
    frames.add(node.frame.id);
    for (const child of node.childFrames ?? []) visit(child);
  };
  visit(tree.frameTree);
  const browser = await session.getBrowserClient();
  const directory = isolated ? await mkdtemp(path.join(os.tmpdir(), 'mearl-download-')) : undefined;
  captures.add(session);
  let guid: string | undefined;
  let filename = '';
  let filePath: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void done.catch(() => {});
  const stopBegin = browser.on('Browser.downloadWillBegin', event => {
    if (!frames.has(event.frameId) || (data.url && data.url !== event.url)) return;
    if (guid) {
      reject(new Error('DOWNLOAD_CAPTURE_AMBIGUOUS'));
      return;
    }
    guid = event.guid;
    filename = path.basename(event.suggestedFilename);
  });
  const stopProgress = browser.on('Browser.downloadProgress', event => {
    if (event.guid !== guid) return;
    if (event.state === 'completed') {
      filePath = event.filePath ?? (directory ? path.join(directory, guid!) : undefined);
      resolve();
    }
    if (event.state === 'canceled') reject(new Error('DOWNLOAD_CANCELED'));
  });
  try {
    // Redirect files only in Mearl-owned isolated browsers; shared user contexts keep their directory.
    await browser.sendCommand('Browser.setDownloadBehavior', {
      behavior: directory ? 'allowAndName' : 'default',
      ...(directory ? { downloadPath: directory } : {}),
      eventsEnabled: true,
    });
    timer = setTimeout(
      () =>
        reject(new Error('DOWNLOAD_CAPTURE_UNCERTAIN: inspect browser downloads before retrying')),
      timeout,
    );
    const action = await trigger();
    await done;
    if (!filePath)
      throw new Error(
        'DOWNLOAD_PATH_UNAVAILABLE: this Chrome did not expose its completed file path',
      );
    // The artifact importer removes the owned file; its temporary directory is reclaimed below on failure.
    return { filename, filePath, action, owned: !!directory, directory };
  } catch (error) {
    if (guid && directory && !String(error).includes('AMBIGUOUS')) {
      await browser.sendCommand('Browser.cancelDownload', { guid }).catch(() => {});
      await rm(path.join(directory, guid), { force: true }).catch(() => {});
    }
    if (directory) await rmdir(directory).catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    stopBegin();
    stopProgress();
    captures.delete(session);
    await browser
      .sendCommand('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false })
      .catch(() => {});
  }
}
