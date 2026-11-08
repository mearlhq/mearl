import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, globalAgent } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { resolveChromeExecutable } from '../../managed-browser.js';
import { CdpSession, type PageSession } from '../cdp-session.js';
import { readDevToolsActivePort } from '../discover.js';
import { cdpSendRequest } from '../http-handlers.js';
import { syncResponseCookies } from '../response-cookies.js';

describe.skipIf(process.env.MEARL_RUN_COOKIE_INTEGRATION !== '1')(
  'Chrome proxy cookie lifecycle',
  () => {
    it('uses first-party CHIPS without a page and preserves response cookie lifecycle', async () => {
      const profile = mkdtempSync(join(tmpdir(), 'mearl-cookie-integration-'));
      const keyPath = join(profile, 'key.pem');
      const certPath = join(profile, 'cert.pem');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
          '-keyout',
          keyPath,
          '-out',
          certPath,
        ],
        { stdio: 'ignore' },
      );
      const cert = readFileSync(certPath);
      const previousCa = globalAgent.options.ca;
      globalAgent.options.ca = cert;
      const server = createServer({ key: readFileSync(keyPath), cert }, (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/api/chips-login') {
          if (!request.headers.cookie?.includes('chips=first-party')) {
            response.setHeader('Content-Type', 'text/html');
            response.end('<html>SSO login required</html>');
          } else {
            response.end(JSON.stringify({ success: true }));
          }
          return;
        }
        if (request.url === '/api/refresh') {
          response.setHeader('Set-Cookie', [
            'session=renewed; HttpOnly; Path=/api; SameSite=None; Secure',
            'shared=parent; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; SameSite=None; Secure',
            'stale=; Path=/api; Max-Age=0; SameSite=None; Secure',
          ]);
        } else if (request.url === '/api/anonymous') {
          response.setHeader('Set-Cookie', 'session=anonymous; Path=/api; SameSite=None; Secure');
        } else if (request.url === '/api/delete') {
          response.setHeader('Set-Cookie', 'session=; Path=/api; Max-Age=0; SameSite=None; Secure');
        } else if (request.url === '/api/invalid-json') {
          response.setHeader(
            'Set-Cookie',
            'rotated=present; HttpOnly; Path=/api; SameSite=None; Secure',
          );
          response.end('invalid json');
          return;
        } else if (request.url === '/api/redirect') {
          response.statusCode = 302;
          response.setHeader(
            'Set-Cookie',
            'session=redirected; HttpOnly; Path=/; SameSite=None; Secure',
          );
          response.setHeader('Location', '/public/echo');
        }
        response.end(JSON.stringify({ cookie: request.headers.cookie ?? '' }));
      });
      let chrome: ChildProcess | undefined;
      let cdp: CdpSession | undefined;
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No fixture port');
        const origin = `https://127.0.0.1:${address.port}`;
        const extensionPath = join(profile, 'cookie-extension');
        mkdirSync(extensionPath);
        writeFileSync(
          join(extensionPath, 'manifest.json'),
          JSON.stringify({
            manifest_version: 3,
            name: 'Mearl cookie regression fixture',
            version: '1.0',
            permissions: ['cookies', 'declarativeNetRequest'],
            host_permissions: ['<all_urls>'],
            background: { service_worker: 'worker.js', type: 'module' },
          }),
        );
        await build({
          stdin: {
            contents: `import { handleSendRequest } from ${JSON.stringify(fileURLToPath(new URL('../../../../extension/src/pages/background/agentHandlers/httpHandlers.ts', import.meta.url)))}; import { collectCookies } from ${JSON.stringify(fileURLToPath(new URL('../../../../extension/src/pages/background/utils/dnr.ts', import.meta.url)))}; globalThis.proxyRequest = handleSendRequest; globalThis.collectCookies = collectCookies;`,
            resolveDir: profile,
            loader: 'ts',
          },
          bundle: true,
          platform: 'browser',
          format: 'esm',
          outfile: join(extensionPath, 'worker.js'),
        });
        chrome = spawn(
          resolveChromeExecutable(),
          [
            '--headless=new',
            '--no-first-run',
            '--no-default-browser-check',
            '--ignore-certificate-errors',
            '--enable-unsafe-extension-debugging',
            '--remote-debugging-port=0',
            `--user-data-dir=${profile}`,
            `${origin}/`,
          ],
          { stdio: 'ignore' },
        );
        const deadline = Date.now() + 15000;
        let page: PageSession | undefined;
        while (Date.now() < deadline) {
          if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${chrome.exitCode}`);
          const port = readDevToolsActivePort(profile);
          if (port && !cdp) cdp = new CdpSession({ port: port.port, userDataDir: profile });
          if (cdp) page = await cdp.getPageSession().catch(() => undefined);
          if (page) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!page) throw new Error('Chrome fixture did not start');
        for (const cookie of [
          { name: 'session', value: 'root', path: '/' },
          { name: 'session', value: 'old', path: '/api', httpOnly: true },
          { name: 'stale', value: 'old', path: '/api' },
        ]) {
          await page.client.sendCommand('Network.setCookie', { url: origin, ...cookie });
        }
        for (const [value, topLevelSite, hasCrossSiteAncestor] of [
          ['first-party', 'https://127.0.0.1', false],
          ['other-site', 'https://other.test', false],
          ['cross-site-ancestor', 'https://127.0.0.1', true],
        ] as const) {
          const applied = await page.client.sendCommand('Network.setCookie', {
            url: origin,
            name: 'chips',
            value,
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'None',
            partitionKey: { topLevelSite, hasCrossSiteAncestor },
          });
          expect(applied.success).toBe(true);
        }
        await page.client.sendCommand('Page.navigate', { url: 'about:blank' });
        expect((await cdpSendRequest(page, { url: `${origin}/api/chips-login` })).body).toEqual({
          success: true,
        });
        expect(
          (await cdpSendRequest(page, { url: `${origin}/api/chips-login`, withCookies: false }))
            .bodyType,
        ).toBe('text');
        const refresh = await cdpSendRequest(page, { url: `${origin}/api/refresh` });
        expect(refresh.body.cookie).toContain('chips=first-party');
        expect(refresh.body.cookie).not.toContain('chips=other-site');
        expect(refresh.body.cookie).not.toContain('chips=cross-site-ancestor');
        expect(refresh.body.cookie).toContain('session=old');
        expect(refresh.body.cookie).toContain('session=root');
        expect(refresh.cookieSync).toEqual({ updatedCount: 3, rejectedCount: 0, failedCount: 0 });
        expect(refresh.headers['set-cookie']).toBeUndefined();
        const echo = await cdpSendRequest(page, { url: `${origin}/api/echo` });
        expect(
          echo.body.cookie.split('; ').filter((value: string) => value.startsWith('session=')),
        ).toEqual(['session=renewed', 'session=root']);
        expect(echo.body.cookie).toContain('shared=parent');
        expect(echo.body.cookie).not.toContain('stale=');
        const stored = await page.client.sendCommand('Network.getCookies', {
          urls: [`${origin}/api/echo`],
        });
        expect(stored.cookies).toContainEqual(
          expect.objectContaining({
            name: 'session',
            value: 'renewed',
            path: '/api',
            httpOnly: true,
          }),
        );
        const anonymous = await cdpSendRequest(page, {
          url: `${origin}/api/anonymous`,
          withCookies: false,
        });
        expect(anonymous.body.cookie).toBe('');
        expect(anonymous.cookieSync).toBeUndefined();
        expect((await cdpSendRequest(page, { url: `${origin}/api/echo` })).body.cookie).toContain(
          'session=renewed',
        );
        await expect(
          cdpSendRequest(page, { url: `${origin}/api/invalid-json`, responseType: 'json' }),
        ).rejects.toThrow('expected a JSON response');
        expect((await cdpSendRequest(page, { url: `${origin}/api/echo` })).body.cookie).toContain(
          'rotated=present',
        );
        await cdpSendRequest(page, { url: `${origin}/api/delete` });
        const afterDelete = await cdpSendRequest(page, { url: `${origin}/api/echo` });
        expect(afterDelete.body.cookie).not.toContain('session=renewed');
        expect(afterDelete.body.cookie).toContain('session=root');

        const browser = await cdp!.getBrowserClient();
        const extension = await browser.sendCommand('Extensions.loadUnpacked', {
          path: extensionPath,
        });
        let workerTargetId: string | undefined;
        const workerDeadline = Date.now() + 5000;
        while (!workerTargetId && Date.now() < workerDeadline) {
          const { targetInfos } = await browser.sendCommand('Target.getTargets');
          workerTargetId = targetInfos.find(
            (target: { type: string; url: string }) =>
              target.type === 'service_worker' &&
              target.url.startsWith(`chrome-extension://${extension.id}/`),
          )?.targetId;
          if (!workerTargetId) await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!workerTargetId) throw new Error('Cookie fixture extension did not start');
        const attached = await browser.sendCommand('Target.attachToTarget', {
          targetId: workerTargetId,
          flatten: true,
        });
        const worker = browser.createChildSession(attached.sessionId);
        const readyDeadline = Date.now() + 5000;
        let ready = false;
        while (!ready && Date.now() < readyDeadline) {
          const state = await worker.sendCommand('Runtime.evaluate', {
            expression: 'typeof globalThis.proxyRequest === "function"',
            returnByValue: true,
          });
          ready = state.result.value === true;
          if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!ready) throw new Error('Cookie fixture worker did not initialize');
        // Query synthetic hosts without navigating: Chrome must normalize origins using its PSL.
        for (const [url, site, otherSite] of [
          ['https://api.example.co.uk:8443/api', 'https://example.co.uk', 'https://other.co.uk'],
          [
            'https://api.tenant.github.io/api',
            'https://tenant.github.io',
            'https://other.github.io',
          ],
          ['https://localhost:8080/api', 'https://localhost', 'https://other.test'],
          ['https://[::1]:8080/api', 'https://[::1]', 'https://other.test'],
        ]) {
          for (const [value, topLevelSite, hasCrossSiteAncestor] of [
            ['first-party', site, false],
            ['other-site', otherSite, false],
            ['cross-site-ancestor', site, true],
          ] as const) {
            const applied = await page.client.sendCommand('Network.setCookie', {
              url,
              name: 'partition-probe',
              value,
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'None',
              partitionKey: { topLevelSite, hasCrossSiteAncestor },
            });
            expect(applied.success).toBe(true);
          }
          const collected = await worker.sendCommand('Runtime.evaluate', {
            expression: `globalThis.collectCookies(new URL(${JSON.stringify(url)})).then(cookies => cookies.map(cookie => cookie.value))`,
            awaitPromise: true,
            returnByValue: true,
          });
          expect(collected.exceptionDetails).toBeUndefined();
          expect(collected.result.value).toEqual(['first-party']);
        }
        const extensionRequest = async (path: string, withCookies = true) => {
          const evaluated = await worker.sendCommand('Runtime.evaluate', {
            expression: `globalThis.proxyRequest(${JSON.stringify({ url: origin + path, withCookies })})`,
            awaitPromise: true,
            returnByValue: true,
          });
          if (evaluated.exceptionDetails)
            throw new Error(
              `Extension proxy fixture failed: ${evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text}`,
            );
          return evaluated.result.value;
        };
        await extensionRequest('/api/refresh');
        expect((await extensionRequest('/api/chips-login')).body).toEqual({ success: true });
        expect((await extensionRequest('/api/chips-login', false)).bodyType).toBe('text');
        const extensionEcho = await extensionRequest('/api/echo');
        expect(extensionEcho.body.cookie).toContain('chips=first-party');
        expect(extensionEcho.body.cookie).not.toContain('chips=other-site');
        expect(extensionEcho.body.cookie).not.toContain('chips=cross-site-ancestor');
        expect(
          extensionEcho.body.cookie
            .split('; ')
            .filter((value: string) => value.startsWith('session=')),
        ).toEqual(['session=renewed', 'session=root']);
        expect(extensionEcho.headers['set-cookie']).toBeUndefined();
        expect((await extensionRequest('/api/anonymous', false)).body.cookie).toBe('');
        expect((await extensionRequest('/api/echo')).body.cookie).toContain('session=renewed');
        const redirected = await extensionRequest('/api/redirect');
        expect(redirected.body.cookie).toContain('session=redirected');
        expect(redirected.body.cookie).not.toContain('session=renewed');
        expect(redirected.body.cookie).not.toContain('session=root');
        await extensionRequest('/api/delete');
        expect((await extensionRequest('/api/echo')).body.cookie).not.toContain('session=renewed');
        await page.client.sendCommand('Network.clearBrowserCookies');
        expect((await extensionRequest('/api/refresh')).attachedCookieCount).toBe(0);
        expect((await extensionRequest('/api/echo')).body.cookie).toContain('session=renewed');
        await page.client.sendCommand('Network.setCookie', {
          url: 'https://cookie.test/',
          name: 'protected',
          value: 'secure',
          path: '/',
          secure: true,
          httpOnly: true,
        });
        expect(
          await syncResponseCookies(page, 'http://cookie.test/', ['protected=insecure; Path=/']),
        ).toEqual({ updatedCount: 0, rejectedCount: 1, failedCount: 0 });
        const protectedCookies = await page.client.sendCommand('Network.getCookies', {
          urls: ['https://cookie.test/'],
        });
        expect(protectedCookies.cookies).toContainEqual(
          expect.objectContaining({
            name: 'protected',
            value: 'secure',
            secure: true,
            httpOnly: true,
          }),
        );
      } finally {
        globalAgent.options.ca = previousCa;
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
  },
);
