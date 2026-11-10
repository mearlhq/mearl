import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { resolveChromeExecutable } from '../managed-browser.js';
import { fileURLToPath } from 'node:url';
describe.skipIf(process.env.MEARL_RUN_CONTROL_INTEGRATION !== '1')(
  'compiled browser control lifecycle',
  () => {
    it('downloads, transfers, uploads and hands control back in an isolated Chrome', async () => {
      const root = fileURLToPath(new URL('../../../../', import.meta.url));
      const { UnifiedClient } = await import(
        new URL('../../../client/dist/unified.js', import.meta.url).href
      );
      const directory = await mkdtemp(path.join(tmpdir(), 'mearl-control-integration-'));
      const content = Buffer.alloc(1200000, 123);
      const server = createServer((req, res) => {
        if (req.url === '/file') {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="result.bin"',
          });
          res.end(content);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<button id="export" onclick="location.href=\'/file\'">Export</button><input id="upload" type="file" onchange="window.uploadBytes=this.files[0].size;window.uploadName=this.files[0].name"><div id="result"></div>',
        );
      });
      let chrome: ReturnType<typeof spawn> | undefined, host: ReturnType<typeof spawn> | undefined;
      let nativeLog = '';
      const browserId = 'managed:control-integration-' + path.basename(directory);
      const client = new UnifiedClient();
      async function eventually<T>(fn: () => Promise<T>): Promise<T> {
        let error;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          try {
            return await fn();
          } catch (e) {
            error = e;
            await new Promise(r => setTimeout(r, 50));
          }
        }
        throw error;
      }
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        chrome = spawn(
          resolveChromeExecutable(),
          [
            '--headless=new',
            '--no-first-run',
            '--no-default-browser-check',
            '--remote-debugging-port=0',
            '--user-data-dir=' + directory,
            'about:blank',
          ],
          { stdio: 'ignore' },
        );
        const port = await eventually(async () =>
          Number(
            (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
          ),
        );
        host = spawn(
          process.execPath,
          [
            path.join(root, 'packages/native-host/dist/index.js'),
            '--daemon',
            '--cdp-port',
            String(port),
            '--cdp-user-data-dir',
            directory,
            '--browser-id',
            browserId,
            '--browser-headless',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        host.stdout?.on('data', chunk => (nativeLog += chunk));
        host.stderr?.on('data', chunk => (nativeLog += chunk));
        await eventually(async () => {
          await access(path.join(tmpdir(), `mearl-agent-${host.pid}.sock`));
          const all = await client.invoke('browser_list', {}, { local: true });
          assert(
            all.browsers.some(
              (b: any) => b.originalBrowserId === browserId || b.browserId.includes(browserId),
            ),
          );
        });
        const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`;
        const opened = await client.invoke(
          'tab_open',
          { url },
          { session: 'new', browser: 'mearl:local:' + browserId },
        );
        assert(opened.session);
        assert.match(opened.session.sessionId, /^s_[A-Za-z0-9_-]{8}$/);
        const options = { session: opened.session.sessionId };
        const tabId = opened.tabId;
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `import { runMearlCli } from ${JSON.stringify(new URL('../../../client/dist/cli.js', import.meta.url).href)};
          process.exitCode = await runMearlCli(process.argv.slice(1));`,
            'page_snapshot',
            '--local',
            '--session',
            options.session,
            '--payload',
            JSON.stringify({ tabId }),
          ],
          { timeout: 20000 },
        );
        const reused = JSON.parse(stdout);
        assert.equal(reused.session.sessionId, options.session);
        assert.equal(reused.session.browserId, opened.session.browserId);
        assert.equal(reused.session.transport, 'cdp');
        const snap = await client.invoke('page_snapshot', { tabId }, options);
        assert(snap.session);
        await assert.rejects(
          client.invoke(
            'page_click',
            { tabId, selector: '#export' },
            { browser: 'mearl:local:' + browserId },
          ),
          /TAB_CONTROLLED/,
        );
        const download = await client.invoke(
          'page_download',
          { tabId, trigger: { selector: '#export' }, timeout: 15000 },
          options,
        );
        const output = path.join(directory, 'saved.bin');
        await client.saveArtifact(download.download, output, options);
        assert((await readFile(output)).equals(content));
        await client.invoke(
          'page_upload',
          {
            tabId,
            selector: '#upload',
            files: [{ artifactId: download.download.artifactId }],
            observe: false,
          },
          options,
        );
        let state = await client.invoke(
          'page_eval',
          { tabId, expression: '({bytes:window.uploadBytes,name:window.uploadName})' },
          options,
        );
        assert.deepEqual(state.result, { bytes: content.length, name: 'result.bin' });
        await client.invoke(
          'page_upload',
          { tabId, selector: '#upload', files: [{ filePath: output }], observe: false },
          options,
        );
        state = await client.invoke(
          'page_eval',
          { tabId, expression: '({bytes:window.uploadBytes,name:window.uploadName})' },
          options,
        );
        assert.deepEqual(state.result, { bytes: content.length, name: 'saved.bin' });
        const batch = await client.invoke(
          'run_actions',
          {
            tabId,
            actions: [
              { action: 'page_eval', data: { expression: '21*2' } },
              { action: 'agent_chat_run' },
            ],
          },
          options,
        );
        assert.equal(batch.completedSteps, 1);
        assert.equal(batch.failedStep, 1);
        assert.equal(batch.results[0].data.result, 42);
        await client.invoke(
          'browser_control',
          { operation: 'handoff', reason: 'integration user' },
          { browser: 'mearl:local:' + browserId },
        );
        await assert.rejects(
          client.invoke('page_click', { tabId, selector: '#export' }, options),
          /CONTROL_SESSION_PAUSED/,
        );
        await client.invoke(
          'browser_control',
          { operation: 'resume' },
          { browser: 'mearl:local:' + browserId },
        );
        await client.invoke('page_snapshot', { tabId }, options);
        const keep = await client.invoke(
          'browser_release',
          { closeCreatedTabs: true, keepTabIds: [tabId] },
          options,
        );
        assert(keep.released);
        const tabs = await client.invoke('tab_list', {}, { browser: 'mearl:local:' + browserId });
        assert(tabs.tabs.some((t: any) => t.tabId === tabId));
        await assert.rejects(
          client.invoke(
            '__artifact_read',
            { artifactId: download.download.artifactId, offset: 0 },
            options,
          ),
          /CONTROL_SESSION_PAUSED|ARTIFACT_NOT_FOUND/,
        );
      } catch (error) {
        throw new Error(String(error) + '\n' + nativeLog.slice(-2500), { cause: error });
      } finally {
        client.disconnect();
        if (host) {
          host.kill('SIGTERM');
          await Promise.race([once(host, 'exit'), new Promise(r => setTimeout(r, 3000))]);
          if (host.exitCode === null) host.kill('SIGKILL');
        }
        if (chrome) {
          chrome.kill('SIGTERM');
          await Promise.race([once(chrome, 'exit'), new Promise(r => setTimeout(r, 3000))]);
          if (chrome.exitCode === null) chrome.kill('SIGKILL');
        }
        await new Promise(r => server.close(r));
        await rm(directory, { recursive: true, force: true });
      }
    }, 60000);
  },
);
