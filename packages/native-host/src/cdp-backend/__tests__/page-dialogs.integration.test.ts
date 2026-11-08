import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChromeExecutable } from '../../managed-browser.js';
import { CdpSession } from '../cdp-session.js';
import { readDevToolsActivePort } from '../discover.js';
import { dispatchCdpAction, cdpObservedPageAction } from '../handlers.js';
import { getCdpPageDialogs } from '../page-dialogs.js';

describe.skipIf(process.env.MEARL_RUN_DIALOG_INTEGRATION !== '1')('Chrome native dialog lifecycle', () => {
  it('reads pre-existing dialogs and recovers from an eval that never settles after prompt acceptance', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'mearl-dialog-integration-'));
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Dialog fixture</title><button id="confirm" onclick="window.clicks=(window.clicks||0)+1;window.accepted=confirm(\'Continue?\')">Confirm</button>');
    });
    let chrome: ChildProcess | undefined;
    let cdp: CdpSession | undefined;
    const watchdog = setTimeout(() => { chrome?.kill('SIGKILL'); }, 25000);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture port');
      const url = `http://127.0.0.1:${address.port}/`;
      chrome = spawn(resolveChromeExecutable(), [
        '--headless=new', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, url,
      ], { stdio: 'ignore' });
      await expect.poll(() => readDevToolsActivePort(profile), { timeout: 15000 }).toBeTruthy();
      cdp = new CdpSession({ userDataDir: profile });
      const browser = await cdp.getBrowserClient();
      const { targetInfos } = await browser.sendCommand('Target.getTargets');
      const target = targetInfos.find((target: any) => target.url === url);
      const { sessionId } = await browser.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const other = browser.createChildSession(sessionId);
      await other.sendCommand('Page.enable');
      const opened = new Promise<void>(resolve => other.on('Page.javascriptDialogOpening', () => resolve()));
      const original = other.sendCommand('Runtime.evaluate', { expression: 'confirm("Already open")', returnByValue: true });
      await opened;
      await expect(cdp.getPageSession()).rejects.toThrow('close it manually');
      await other.sendCommand('Page.handleJavaScriptDialog', { accept: false });
      expect((await original).result.value).toBe(false);
      await browser.sendCommand('Target.detachFromTarget', { sessionId });
      const page = await cdp.getPageSession();
      const tabId = page.tabId;
      const nextOpened = new Promise<void>(resolve => page.client.on('Page.javascriptDialogOpening', () => resolve()));
      const nextOriginal = page.client.sendCommand('Runtime.evaluate', { expression: 'confirm("Already open")', returnByValue: true });
      await nextOpened;
      const snapshot = await dispatchCdpAction(cdp, 'page_snapshot', { tabId });
      expect(snapshot.dialog).toMatchObject({ type: 'confirm', message: 'Already open' });
      await expect(dispatchCdpAction(cdp, 'page_press', { tabId, key: 'Enter' })).rejects.toThrow('DIALOG_PENDING');
      await dispatchCdpAction(cdp, 'page_press', { tabId, key: 'Escape', dialogId: snapshot.dialog.id });
      expect((await nextOriginal).result.value).toBe(false);

      const interrupted = dispatchCdpAction(cdp, 'page_eval', {
        tabId, expression: '(async()=>{globalThis.answer=prompt("Name?","Guest");await new Promise(()=>{});globalThis.replayed=true})()',
      });
      const failure = expect(interrupted).rejects.toMatchObject({ code: 'DIALOG_PENDING' });
      await expect.poll(() => getCdpPageDialogs(page).info()?.type).toBe('prompt');
      await failure;
      const prompt = await dispatchCdpAction(cdp, 'page_snapshot', { tabId });
      await dispatchCdpAction(cdp, 'page_press', { tabId, key: 'Enter', dialogId: prompt.dialog.id, promptText: 'Alice' });
      await expect(dispatchCdpAction(cdp, 'page_eval', { tabId, expression: '[answer,typeof replayed,1+1]' })).resolves.toEqual({ result: ['Alice', 'undefined', 2] });
      await expect(dispatchCdpAction(cdp, 'page_press', { tabId, key: 'Enter', dialogId: prompt.dialog.id })).rejects.toThrow('stale');

      const click = await cdpObservedPageAction(cdp, 'page_click', { tabId, selector: '#confirm', clickMode: 'dom' });
      expect(click).toMatchObject({ action: { success: false, stage: 'dispatch-uncertain' }, dialog: { type: 'confirm' } });
      await dispatchCdpAction(cdp, 'page_press', { tabId, key: 'Enter', dialogId: click.dialog.id });
      await expect(dispatchCdpAction(cdp, 'page_eval', { tabId, expression: '[clicks,accepted]' })).resolves.toEqual({ result: [1, true] });
      expect((await dispatchCdpAction(cdp, 'page_snapshot', { tabId })).snapshot).toContain('Confirm');

      const defaultPrompt = dispatchCdpAction(cdp, 'page_eval', { tabId, expression: 'globalThis.defaultAnswer=prompt("Default?","Guest")' });
      const promptFailure = expect(defaultPrompt).rejects.toMatchObject({ code: 'DIALOG_PENDING' });
      await expect.poll(() => getCdpPageDialogs(page).info()?.type).toBe('prompt');
      await promptFailure;
      const defaultDialog = getCdpPageDialogs(page).info()!;
      expect(defaultDialog.defaultPrompt).toBe('Guest');
      await dispatchCdpAction(cdp, 'page_press', { tabId, key: 'Enter', dialogId: defaultDialog.id });
      await expect(dispatchCdpAction(cdp, 'page_eval', { tabId, expression: 'defaultAnswer' })).resolves.toEqual({ result: 'Guest' });
    } finally {
      clearTimeout(watchdog);
      cdp?.close();
      if (chrome && chrome.exitCode === null) {
        chrome.kill('SIGKILL');
        await once(chrome, 'exit');
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(profile, { recursive: true, force: true });
    }
  }, 30000);
});
