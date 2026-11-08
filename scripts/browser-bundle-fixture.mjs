import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = await build({
  absWorkingDir: root, entryPoints: ['packages/preset/src/bundles.ts'],
  bundle: true, platform: 'browser', target: 'es2022', format: 'esm', write: false,
});
const profile = Buffer.from(JSON.stringify({ name: 'sample/app', label: 'Sample browser profile' }));
const manifest = {
  schemaVersion: 1, id: 'sample', version: '1.0.0',
  resources: { 'profile.json': { sha256: createHash('sha256').update(profile).digest('hex'), byteLength: profile.length } },
  contributions: { appProfiles: ['profile.json'] },
};
let downloads = 0;
let packagesAvailable = true;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Browser capability storage verification</title>
<h1>Browser capability storage verification</h1>
<p>This page uses browser storage and Web Crypto. It has no extension or native-host connection.</p>
<button id="install">Install sample bundle</button>
<button id="preset">Install sample preset</button>
<button id="bad">Attempt corrupt update</button>
<a href="/">Reload and restore</a>
<pre id="result">Loading local storage</pre>
<script type="module">
import { BrowserBundleStore, createBundleFetchLoader, prepareBundle, prepareBrowserPreset, readBundleJson } from '/runtime.js';
const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0' });
const result = document.getElementById('result');
const display = async stage => {
  const bundle = await store.get('sample');
  const binding = await store.profileBinding('sample');
  result.textContent = JSON.stringify({ stage, installed: Boolean(bundle), version: bundle?.manifest.version,
    profile: bundle && readBundleJson(bundle, 'profile.json').name, selectedProvider: binding?.target });
};
await display('restored');
document.getElementById('preset').onclick = async () => {
  try {
    const previous = await store.list();
    const prepared = await prepareBrowserPreset(new URL('/preset.json', location.href).href, { mearlApiVersion: '1.0.0', load: createBundleFetchLoader() });
    for (const bundle of prepared.bundles) if (readBundleJson(bundle, 'profile.json').name !== 'sample/app') throw new Error('Invalid fixture contribution');
    await store.activatePreset(prepared.snapshot, prepared.bundles.map(bundle => ({ bundle, expectedRevision: previous.revisions[bundle.manifest.id] ?? null })), previous.activeRevision);
    await display('preset-installed');
  } catch (error) { result.textContent = String(error); }
};
document.getElementById('install').onclick = async () => {
  try {
    const existing = await store.get('sample');
    const bundle = await prepareBundle(new URL('/bundle.json', location.href).href, {
      expectedId: 'sample', mearlApiVersion: '1.0.0', load: createBundleFetchLoader()
    });
    await store.install(bundle, existing?.revision ?? null);
    await display('installed');
  } catch (error) { result.textContent = String(error); }
};
document.getElementById('bad').onclick = async () => {
  try {
    const existing = await store.get('sample');
    const bundle = await prepareBundle(new URL('/bad/bundle.json', location.href).href, {
      expectedId: 'sample', mearlApiVersion: '1.0.0', load: createBundleFetchLoader()
    });
    await store.install(bundle, existing?.revision ?? null);
    await display('unexpected-update');
  } catch (error) { await display('rejected-corrupt-update'); }
};
</script></html>`;

const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/runtime.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end(runtime.outputFiles[0].text);
  } else if (request.url === '/bundle.json' || request.url === '/profile.json') {
    if (!packagesAvailable) { response.writeHead(503); response.end('Package source offline'); return; }
    downloads++;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/bundle.json') response.end(JSON.stringify(manifest));
    else { response.end(profile); packagesAvailable = false; }
  } else if (request.url === '/preset.json') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ schemaVersion: 1, id: 'sample', version: '1.0.0', packages: { sample: { source: './bundle.json', targets: ['browser'] } }, appProfiles: { sample: 'sample/app' } }));
  } else if (request.url === '/bad/bundle.json') {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ...manifest, version: '2.0.0' }));
  } else if (request.url === '/bad/profile.json') {
    const corrupt = Buffer.from(profile); corrupt[0] ^= 1;
    response.setHeader('Content-Type', 'application/json'); response.end(corrupt);
  } else if (request.url === '/state.json') {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ downloads, packagesAvailable }));
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html'); response.end(html);
  } else { response.writeHead(404); response.end(); }
});

server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, stop: 'Send close on stdin' })));
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { if (data.trim() === 'close') server.close(() => process.exit(0)); });
process.on('SIGINT', () => server.close(() => process.exit(0)));
