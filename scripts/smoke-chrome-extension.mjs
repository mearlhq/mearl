import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, until } from './chrome-smoke-helpers.mjs';

const chromePath = process.argv[2];
assert.ok(chromePath, 'Pass the Chrome for Testing executable path');
const directory = await mkdtemp(join(tmpdir(), 'mearl-extension-smoke-'));
const extension = join(directory, 'extension');
const profile = join(directory, 'profile');
const builtExtension = fileURLToPath(
  new URL('../packages/extension/dist_chrome/', import.meta.url),
);
const site = JSON.parse(
  await readFile(new URL('../packages/preset/installation-site.json', import.meta.url)),
);
const guideUrl = new URL('installed.html', site.url);
const presetUrl = 'https://api.github.com/mearl-smoke-preset.json';
const editedUrl = 'https://api.github.com/mearl-smoke-preset-updated.json';
const presetId = 'browser-smoke';
const presetRequests = [];
let chrome;
let server;
let cdp;

try {
  await cp(builtExtension, extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Use a separate extension ID so a local run cannot connect to an installed Native Host.
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  manifest.key = key.toString('base64');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const extensionId = createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 32)
    .replace(/./g, hex => String.fromCharCode(97 + Number.parseInt(hex, 16)));
  const optionsUrl = `chrome-extension://${extensionId}/${manifest.options_ui.page}`;
  const popupUrl = `chrome-extension://${extensionId}/${manifest.action.default_popup}`;

  const keyPath = join(directory, 'fixture-key.pem');
  const certPath = join(directory, 'fixture-cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=api.github.com',
    ],
    { stdio: 'ignore' },
  );
  server = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (request, response) => {
      const url = new URL(request.url, `https://${request.headers.host}`);
      if (url.href === presetUrl || url.href === editedUrl) {
        presetRequests.push(url.href);
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            schemaVersion: 1,
            id: presetId,
            version: url.href === editedUrl ? '1.1.0' : '1.0.0',
            defaults: {
              extension: { messages: { presetInstallPurpose: { en: 'Chrome smoke test' } } },
            },
          }),
        );
      } else if (url.href === new URL('installation.json', site.url).href) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ schemaVersion: 1 }));
      } else if (url.href === guideUrl.href) {
        response.end('Installation guide');
      } else {
        response.writeHead(404).end();
      }
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `127.0.0.1:${server.address().port}`;
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-first-run',
      '--disable-background-networking',
      '--no-proxy-server',
      '--ignore-certificate-errors',
      `--host-resolver-rules=MAP api.github.com:443 ${address},MAP ${guideUrl.host}:443 ${address}`,
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.on('error', error => console.error(error));
  let chromeLog = '';
  chrome.stderr.on('data', chunk => {
    chromeLog = (chromeLog + String(chunk)).slice(-4000);
  });
  const port = await until(
    async () => {
      if (chrome.exitCode !== null) throw new Error(chromeLog);
      return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    },
    'Chrome startup',
    15_000,
  );
  const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  cdp = await connect(browser.webSocketDebuggerUrl);
  await until(
    async () => {
      const { targetInfos } = await cdp.call('Target.getTargets');
      return targetInfos.some(target => target.type === 'page' && target.url === guideUrl.href);
    },
    'first-install guide',
    15_000,
  );
  const { targetId } = await cdp.call('Target.createTarget', { url: optionsUrl });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const { result, exceptionDetails } = await cdp.call(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      sessionId,
    );
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const message = (action, payload = {}) =>
    evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ action, ...payload })})`);
  const status = () => message('mearlPresetManagement', { operation: 'status' });
  const wait = (expression, description) => until(() => evaluate(expression), description, 15_000);
  const measureLayout = async doc => {
    const dimensions = await wait(
      `(() => {
      const settings = ${doc};
      const input = settings.querySelector('#installed-presets input[type=url]');
      const agent = settings.querySelector('button[role=switch][aria-label="Agent 服务"], button[role=switch][aria-label="Agent Service"]');
      if (!input || !agent) return;
      const button = input.form.querySelector('button[type=submit]');
      const { height: inputHeight, top: inputTop } = input.getBoundingClientRect();
      const { height: buttonHeight, top: buttonTop } = button.getBoundingClientRect();
      return {
        inputHeight, inputTop, buttonHeight, buttonTop,
        presetHeight: input.closest('section').firstElementChild.getBoundingClientRect().height,
        agentHeight: agent.parentElement.parentElement.getBoundingClientRect().height,
      };
    })()`,
      'Preset and Agent settings layout',
    );
    assert.ok(dimensions.inputHeight > 0, 'Preset controls are visible');
    assert.equal(
      dimensions.inputHeight,
      dimensions.buttonHeight,
      'Preset controls have equal height',
    );
    assert.equal(dimensions.inputTop, dimensions.buttonTop, 'Preset controls share a top edge');
    assert.ok(
      Math.abs(dimensions.presetHeight - dimensions.agentHeight) <= 8,
      `Preset and Agent cards should have similar heights: ${JSON.stringify(dimensions)}`,
    );
  };
  const click = async (pattern, doc = 'document') =>
    wait(
      `(() => {
    const button = Array.from(${doc}.querySelectorAll('button')).find(item =>
      !item.disabled && item.getBoundingClientRect().height && ${pattern}.test(item.textContent.trim()));
    if (!button) return false;
    button.click();
    return true;
  })()`,
      `button ${pattern}`,
    );
  async function enablePreset(doc, source, version) {
    const start = presetRequests.length;
    await evaluate(`(() => {
      const input = ${doc}.querySelector('#installed-presets input[type=url]');
      const type = input.ownerDocument.defaultView.HTMLInputElement;
      Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(input, ${JSON.stringify(source)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click(/^(使用链接|Use link)$/, doc);
    await wait("Boolean(document.querySelector('dialog[open]'))", 'Preset source consent');
    assert.equal(
      presetRequests.length,
      start,
      'Opening settings and entering a link must not fetch the Preset',
    );
    await click(/^(读取 Preset|Read Preset)$/);
    await click(/^(启用能力|Enable capabilities)$/);
    await until(
      async () => {
        const current = await status();
        assert.equal(current.success, true, JSON.stringify(current));
        return current.data.some(
          preset =>
            preset.id === presetId && preset.source === source && preset.version === version,
        );
      },
      `enabled Preset ${version}`,
      15_000,
    );
  }

  await measureLayout('document');
  assert.deepEqual(await status(), { success: true, data: [] });
  assert.deepEqual(await message('mearlPresetManagement', { operation: 'install-available' }), {
    success: true,
    data: false,
  });
  assert.equal((await message('getTranslationCache')).success, true);
  assert.deepEqual(await message('translateJson', { data: { count: 3 }, targetLang: 'en' }), {
    success: false,
    error: 'noChineseFields',
  });
  assert.equal(
    (
      await message('browserTracking', {
        data: { operation: 'decode', input: { url: 'https://example.test/request' } },
      })
    ).success,
    true,
  );
  await enablePreset('document', presetUrl, '1.0.0');

  await cdp.call(
    'Emulation.setDeviceMetricsOverride',
    { width: 640, height: 600, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await cdp.call('Page.navigate', { url: popupUrl }, sessionId);
  await wait(
    `(() => {
    const trigger = document.querySelector('button[aria-expanded][title="设置"], button[aria-expanded][title="Settings"]');
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`,
    'Popup quick settings',
  );
  await click(/^(更多设置|More settings)$/i);
  const popupSettings = "document.querySelector('iframe[src*=options]')?.contentDocument";
  await measureLayout(popupSettings);
  await wait(
    `${popupSettings}?.querySelector('#installed-presets input')?.value === ${JSON.stringify(presetUrl)}`,
    'Prefilled Preset URL in Popup settings',
  );
  await enablePreset(popupSettings, editedUrl, '1.1.0');
  console.log(
    'Chrome extension passed first install, background messages, Preset install/update and settings layout.',
  );
} finally {
  if (cdp) {
    await cdp.call('Browser.close').catch(() => {});
    cdp.close();
  }
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill();
    await once(chrome, 'exit');
  }
  server?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
