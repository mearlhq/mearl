import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Registration and Chrome are confined to an ephemeral GitHub-hosted Windows runner.
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.ok(process.env.RUNNER_TEMP);
const version = process.env.SMOKE_VERSION;
assert.match(version ?? '', /^\d+\.\d+\.\d+-beta\.\d+$/);
const runtime = resolve(process.env.SMOKE_RUNTIME);
const extension = resolve(process.env.SMOKE_EXTENSION);
const chromePath = resolve(process.env.SMOKE_CHROME);
const directory = join(process.env.RUNNER_TEMP, 'mearl-windows-smoke');
const profile = join(directory, 'profile');
await mkdir(profile, { recursive: true });
const require = createRequire(join(runtime, 'package.json'));
const nativePath = require.resolve('@mearl/native-host');
const { installNativeHost, uninstallNativeHost, resolveHostDir } = await import(pathToFileURL(nativePath));
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.version_name, version);
for (const name of ['setup', 'native-host', 'client']) {
  const installed = JSON.parse(await readFile(join(runtime, `node_modules/@mearl/${name}/package.json`), 'utf8'));
  assert.equal(installed.version, version, `Installed version: ${name}`);
}
const extensionId = 'aoehhjnofngknnjefamjbplchbolghkm';
const hosts = ['ai.mearl.skills', 'ai.mearl.mcp'];
const proof = { version, platform: process.platform, registration: false, chromeHandshake: false, cliTransport: false, cleanup: false };
let chrome;
let cdp;
let installationAttempted = false;
const failures = [];

async function until(operation, description, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await operation(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`Timed out: ${description}`, { cause: lastError });
}

async function connect(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { call, close: () => socket.close() };
}

function cli(...args) {
  return JSON.parse(execFileSync(process.execPath, [join(runtime, 'node_modules/@mearl/client/dist/bin.js'), ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  }));
}

try {
  // Refuse to overwrite existing registrations, even if this script is run on a reused runner.
  for (const host of hosts) {
    const query = spawn('reg', ['query', `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${host}`], { stdio: 'ignore' });
    assert.notEqual((await once(query, 'exit'))[0], 0, `Existing registration: ${host}`);
  }
  for (const host of hosts) {
    assert.equal(existsSync(join(resolveHostDir(), `${host}.json`)), false, `Existing manifest: ${host}`);
    assert.equal(existsSync(join(resolveHostDir(), `${host}-launcher.cmd`)), false, `Existing launcher: ${host}`);
  }
  installationAttempted = true;
  assert.equal(await installNativeHost({ silent: true }), true);
  for (const host of hosts) {
    const file = join(resolveHostDir(), `${host}.json`);
    const registered = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(registered.name, host);
    assert.deepEqual(registered.allowed_origins, [`chrome-extension://${extensionId}/`]);
    assert.match(registered.path, /-launcher\.cmd$/);
    const query = execFileSync('reg', ['query', `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${host}`, '/ve'], { encoding: 'utf8' });
    assert.ok(query.includes(file), `Registry path does not match ${host}`);
  }
  proof.registration = true;
  chrome = spawn(chromePath, [
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', error => console.error(error));
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'Chrome debugging port');
  const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  proof.chrome = browser.Browser;
  cdp = await connect(browser.webSocketDebuggerUrl);
  const { targetId } = await cdp.call('Target.createTarget', { url: `chrome-extension://${extensionId}/src/pages/options/index.html` });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  const status = await until(async () => {
    const result = await cdp.call('Runtime.evaluate', {
      expression: `(async()=>({version:chrome.runtime.getManifest().version_name,status:await chrome.runtime.sendMessage({action:'getAgentStatus'})}))()`,
      awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    const value = result.result.value;
    return value?.status?.status?.connected && value;
  }, 'Native Messaging handshake');
  assert.equal(status.version, version);
  assert.equal(status.status.status.nativeHostVersion, version);
  proof.chromeHandshake = true;
  const browsers = cli('browser_list');
  const connected = browsers.browsers.filter(browser => browser.status === 'connected' && browser.extensionVersion === version && browser.nativeHostVersion === version);
  assert.equal(connected.length, 1);
  const tabs = cli('tab_list', '--browser', connected[0].browserId);
  assert.ok(Array.isArray(tabs.tabs) && tabs.tabs.length > 0, 'CLI did not receive Chrome tabs');
  proof.cliTransport = true;
} catch (error) {
  failures.push(error);
} finally {
  if (cdp) {
    await cdp.call('Browser.close').catch(() => {});
    cdp.close();
  }
  try {
    if (chrome && chrome.exitCode === null) {
      await until(() => chrome.exitCode !== null, 'Chrome shutdown', 10_000).catch(() => {
        try { execFileSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); }
        catch (error) { if (chrome.exitCode === null) throw error; }
      });
      await until(() => chrome.exitCode !== null, 'Chrome process exit', 5_000);
    }
  } catch (error) { failures.push(error); }
  // Each mode is cleaned independently so one failure does not leave the other behind.
  if (installationAttempted) {
    let removed = true;
    for (const [index, mode] of ['skills', 'mcp'].entries()) {
      try {
        assert.equal(await uninstallNativeHost({ mode, silent: true }), true);
        const host = hosts[index];
        const query = spawn('reg', ['query', `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${host}`], { stdio: 'ignore' });
        assert.notEqual((await once(query, 'exit'))[0], 0, `Registration survived cleanup: ${host}`);
        assert.equal(existsSync(join(resolveHostDir(), `${host}.json`)), false);
        assert.equal(existsSync(join(resolveHostDir(), `${host}-launcher.cmd`)), false);
      } catch (error) { removed = false; failures.push(error); }
    }
    proof.cleanup = removed;
  }
  proof.passed = failures.length === 0 && proof.registration && proof.chromeHandshake && proof.cliTransport && proof.cleanup;
  if (failures.length) proof.errors = failures.map(error => error.message);
  await writeFile(join(directory, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
}
if (failures.length) throw new AggregateError(failures, 'Windows runtime smoke failed');
