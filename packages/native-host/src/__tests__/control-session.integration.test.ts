import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  closeManagedBrowser,
  launchManagedBrowser,
  resolveChromeExecutable,
} from '../managed-browser.js';
import { fileURLToPath } from 'node:url';

const nativeHostScript = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(process.env.MEARL_RUN_CONTROL_INTEGRATION !== '1')(
  'compiled browser control lifecycle',
  () => {
    let chromeExecutable: string;
    let launcherDirectory: string | undefined;

    beforeAll(async () => {
      chromeExecutable = resolveChromeExecutable();
      if (process.platform !== 'darwin') return;
      const accountHome = userInfo().homedir;
      if (homedir() === accountHome) return;

      // Chrome on macOS needs the login home for local networking, even with a separate profile.
      // The host and CLI can still use an isolated HOME for their registry and settings.
      launcherDirectory = await mkdtemp(path.join(tmpdir(), 'mearl-chrome-launcher-'));
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const launcher = path.join(launcherDirectory, 'chrome');
      await writeFile(
        launcher,
        ['#!/bin/sh', `HOME=${quote(accountHome)} exec ${quote(chromeExecutable)} "$@"`, ''].join(
          '\n',
        ),
        { mode: 0o700 },
      );
      chromeExecutable = launcher;
    });

    afterAll(async () => {
      if (launcherDirectory) await rm(launcherDirectory, { recursive: true, force: true });
    });

    it('opens independent CDP tabs in parallel and drops an open queued past the script deadline', async () => {
      const { UnifiedClient } = await import('../../../client/dist/unified.js');
      const { executeScript } = await import('../../../client/dist/script.js');
      const client = new UnifiedClient();
      const name = `navigation-integration-${randomUUID()}`;
      const browser = `mearl:local:managed:${name}`;
      const bothStarted = Promise.withResolvers<void>();
      const held = new Map<string, import('node:http').ServerResponse>();
      const requests: string[] = [];
      const server = createServer((req, res) => {
        const url = req.url ?? '/';
        requests.push(url);
        if (url.startsWith('/slow/')) {
          held.set(url, res);
          if (held.size === 2) bothStarted.resolve();
          return;
        }
        if (url === '/stalled-script') {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.flushHeaders();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<title>Readable fixture</title><script defer src="/stalled-script"></script>');
        setTimeout(() => res.end('<p>Readable body</p>'), 200);
      });
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
        await launchManagedBrowser(
          { name, headless: true, persistent: false, executablePath: chromeExecutable },
          {
            nativeHostScript,
            exportCookies: async () => [],
            log: () => {},
          },
        );
        const open = (path: string, timeoutSec = 10) =>
          client.invoke('tab_open', { url: base + path, reuse: 'prefer' }, { browser, timeoutSec });
        const fast = await open('/fast', 2);
        assert.equal(fast.navigation.status, 'ready');
        assert(requests.includes('/stalled-script'));
        const slow = Promise.all([open('/slow/a'), open('/slow/b')]);
        void slow.catch(() => {});
        await Promise.race([
          bothStarted.promise,
          slow.then(() => assert.fail('Both navigations must start before either finishes')),
        ]);
        const [read, screenshot] = await Promise.all([
          client.invoke(
            'page_eval',
            { tabId: fast.tabId, expression: 'document.title' },
            { browser, timeoutSec: 2 },
          ),
          client.invoke('page_screenshot', { tabId: fast.tabId }, { browser, timeoutSec: 2 }),
        ]);
        assert.equal(read.result, 'Readable fixture');
        assert(screenshot.data);
        const script = await executeScript(
          `await mearl.tabOpen({url:${JSON.stringify(base + '/slow/a')},reuse:"never"}, {timeoutSec:90});`,
          { browser, executionTimeoutSec: 1.5 },
        );
        assert.equal(script.error?.code, 'SCRIPT_TIMEOUT');
        assert(script.pendingActions.includes('tabOpen'));
        assert(script.mayHaveLateEffects);
        for (const res of held.values()) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<title>Slow fixture</title>');
        }
        const [first, second] = await slow;
        assert.notEqual(first.tabId, second.tabId);
        assert.equal((await open('/slow/a')).tabId, first.tabId);
        assert.equal(requests.filter(url => url === '/slow/a').length, 1);
      } finally {
        client.disconnect();
        await closeManagedBrowser(`managed:${name}`).catch(() => {});
        server.closeAllConnections();
        server.close();
      }
    }, 20_000);

    it.each(['own host', 'another host'])(
      'acknowledges close via %s while Chrome has work in flight',
      async via => {
        const client = new (await import('../../../client/dist/unified.js')).UnifiedClient();
        const name = `close-integration-${randomUUID()}`;
        const browser = `mearl:local:managed:${name}`;
        const router = via === 'another host' ? `${name}-router` : undefined;
        let releaseRequest = Promise.withResolvers<() => void>();
        const server = createServer((req, res) => {
          if (req.url === '/hold') {
            releaseRequest.resolve(() => res.end('done'));
            return;
          }
          res.setHeader('content-type', 'text/html');
          res.end('<title>fixture</title>');
        });
        const launched: string[] = [];
        const launch = async (name: string) => {
          launched.push(name);
          return launchManagedBrowser(
            { name, headless: true, persistent: false, executablePath: chromeExecutable },
            {
              nativeHostScript,
              exportCookies: async () => [],
              log: () => {},
            },
          );
        };
        try {
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          const { port } = server.address() as import('node:net').AddressInfo;
          const { cdpPort } = await launch(name);
          if (router) await launch(router);
          const { tabId } = await client.invoke(
            'tab_open',
            { url: `http://127.0.0.1:${port}/` },
            { browser, timeoutSec: 5 },
          );
          const evaluate = (expression: string, timeoutSec = 5) =>
            client.invoke('page_eval', { tabId, expression }, { browser, timeoutSec });
          const startRequest = async () => {
            const action = evaluate('fetch("/hold").then(response => response.text())', 10);
            const release = await Promise.race([
              releaseRequest.promise,
              action.then(() => assert.fail('Expected the HTTP request to remain open')),
            ]);
            return { action, release };
          };
          const first = await startRequest();
          await assert.rejects(evaluate('document.title = "late write"', 0.25), /请求超时/);
          first.release();
          assert.equal((await first.action).result, 'done');
          assert.equal((await evaluate('document.title')).result, 'fixture');

          releaseRequest = Promise.withResolvers<() => void>();
          const second = await startRequest();
          const receipt = await client.invoke(
            'browser_close',
            { browser },
            {
              browser: router ? `mearl:local:managed:${router}` : browser,
              timeoutSec: 3,
            },
          );
          assert.equal(receipt.closed, true);
          await assert.rejects(fetch(`http://127.0.0.1:${cdpPort}/json/version`));
          await assert.rejects(second.action);
        } finally {
          for (const instance of launched)
            await closeManagedBrowser(`managed:${instance}`).catch(() => {});
          server.closeAllConnections();
          server.close();
        }
      },
      20_000,
    );

    it('downloads, transfers, uploads and hands control back in an isolated Chrome', async () => {
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
          chromeExecutable,
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
            nativeHostScript,
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
        const browser = 'mearl:local:' + browserId;
        await eventually(() => client.invoke('tab_list', {}, { browser, timeoutSec: 2 }));
        const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`;
        const opened = await client.invoke('tab_open', { url }, { session: 'new', browser });
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
          client.invoke('page_click', { tabId, selector: '#export' }, { browser }),
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
          { browser },
        );
        await assert.rejects(
          client.invoke('page_click', { tabId, selector: '#export' }, options),
          /CONTROL_SESSION_PAUSED/,
        );
        await client.invoke('browser_control', { operation: 'resume' }, { browser });
        await client.invoke('page_snapshot', { tabId }, options);
        const keep = await client.invoke(
          'browser_release',
          { closeCreatedTabs: true, keepTabIds: [tabId] },
          options,
        );
        assert(keep.released);
        const tabs = await client.invoke('tab_list', {}, { browser });
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
        await Promise.all([stopChild(host), stopChild(chrome)]);
        server.closeAllConnections();
        await new Promise(r => server.close(r));
        await rm(directory, { recursive: true, force: true });
      }
    }, 60000);
  },
);
