import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChromeExecutable } from '../../managed-browser.js';
import { CdpSession, type PageSession } from '../cdp-session.js';
import { readDevToolsActivePort } from '../discover.js';
import { cdpPageEval } from '../interaction-handlers.js';
import { cdpPageFrames } from '../snapshot-handlers.js';

describe.skipIf(process.env.MEARL_RUN_FRAME_INTEGRATION !== '1')('Chrome frame evaluation', () => {
  it('executes page globals in main, same-process and cross-process frames', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'mearl-frame-integration-'));
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture port');
      response.end(
        request.url === '/main'
          ? `<script>window.frameMarker='main';window.addEventListener('load',()=>window.framesReady=true)</script><iframe name="same" src="/same"></iframe><iframe name="cross" src="http://localhost:${address.port}/cross"></iframe>`
          : `<script>window.frameMarker=${JSON.stringify(request.url)};</script>`,
      );
    });
    let chrome: ChildProcess | undefined;
    let cdp: CdpSession | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture port');
      chrome = spawn(
        resolveChromeExecutable(),
        [
          '--headless=new',
          '--no-first-run',
          '--no-default-browser-check',
          '--site-per-process',
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          `http://127.0.0.1:${address.port}/main`,
        ],
        { stdio: 'ignore' },
      );
      const deadline = Date.now() + 15000;
      let page: PageSession | undefined;
      while (Date.now() < deadline) {
        if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${chrome.exitCode}`);
        const activePort = readDevToolsActivePort(profile);
        if (activePort && !cdp) cdp = new CdpSession(activePort.port);
        if (cdp) {
          page = await cdp.getPageSession().catch(() => undefined);
          if (page && (await cdpPageEval(page, { expression: 'window.framesReady' })).result) break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!page) throw new Error('Chrome fixture did not load');
      const { frames } = await cdpPageFrames(page, { tabId: page.tabId });
      const main = frames.find((frame: any) => frame.isMainFrame);
      const same = frames.find((frame: any) => frame.name === 'same');
      const cross = frames.find((frame: any) => frame.name === 'cross');
      expect(main).toBeDefined();
      expect(same).toBeDefined();
      expect(cross).toBeDefined();
      const { targetInfos } = await page.client.sendCommand('Target.getTargets');
      expect(
        targetInfos.some(
          (target: any) => target.type === 'iframe' && target.targetId === cross.frameId,
        ),
      ).toBe(true);
      for (const [frame, marker] of [
        [main, 'main'],
        [same, '/same'],
        [cross, '/cross'],
      ] as const) {
        await expect(
          cdpPageEval(page, {
            tabId: page.tabId,
            frameId: frame.frameId,
            expression: 'Promise.resolve(window.frameMarker)',
          }),
        ).resolves.toEqual({ result: marker });
      }
      await expect(
        cdpPageEval(page, {
          tabId: page.tabId,
          frameId: same.frameId,
          expression: 'window.frameMarker = "updated"',
        }),
      ).resolves.toEqual({ result: 'updated' });
      await expect(
        cdpPageEval(page, {
          tabId: page.tabId,
          frameId: same.frameId,
          expression: 'window.frameMarker',
        }),
      ).resolves.toEqual({ result: 'updated' });
      await expect(
        cdpPageEval(page, { tabId: page.tabId, expression: 'window.frameMarker' }),
      ).resolves.toEqual({ result: 'main' });
      await expect(
        cdpPageEval(page, {
          tabId: page.tabId,
          frameId: 'missing',
          expression: 'window.frameMarker',
        }),
      ).rejects.toMatchObject({ pageActionFailureStage: 'precondition' });
    } finally {
      cdp?.close();
      if (chrome && chrome.exitCode === null) {
        const exited = once(chrome, 'exit');
        chrome.kill('SIGTERM');
        await exited;
      }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(profile, { recursive: true, force: true });
    }
  }, 30000);
});
