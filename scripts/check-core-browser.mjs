import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents: "export * from './packages/browser-core/src/index.ts'; export * from './packages/app-profiles/src/index.ts'; export { installAppProfileRuntime } from './packages/browser-core/src/appProfileRuntime.ts';",
    resolveDir: root,
    sourcefile: 'core-browser-check.ts',
  },
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  globalName: 'MearlCore',
  write: false,
  logLevel: 'silent',
});

const navigator = {};
const result = runInNewContext(`${bundle.outputFiles[0].text}
(() => {
  const definition = { name: 'sample/app', label: 'Sample', appName: 'Sample', defaultAppVersion: '1', uaTokens: [], uaTemplate: { ios: 'Sample/{v} iOS', android: 'Sample/{v} Android' }, globals: {}, bridges: [], activeEvents: [], actions: { open: [], close: [], title: [], systemInfo: [], protocol: [], noop: [] }, schemes: [] };
  const profile = MearlCore.resolveAppProfile('sample/app', { os: 'android', appVersion: '3.0.0' }, definition);
  MearlCore.installAppProfileRuntime(profile.injected);
  const custom = MearlCore.resolveAppProfile('sample/app', {}, { ...definition, name: 'sample/app', pageRuntime: { id: 'sample/main', sha256: 'a'.repeat(64) } });
  return JSON.stringify({ names: MearlCore.listBuiltinAppProfiles().map(profile => profile.id), ua: profile.ua, revision: custom.injected.binding.revision, code: custom.injected.pageRuntime });
})()`, { navigator, URL, TextEncoder, TextDecoder, btoa, atob }, { timeout: 5_000 });
const actual = JSON.parse(result);
assert.deepEqual(actual.names, []);
assert.equal(actual.ua, 'Sample/3.0.0 Android');
assert.equal(navigator.userAgent, actual.ua);
assert.equal(navigator.appVersion, actual.ua.replace(/^Mozilla\//, ''));
assert.equal(navigator.platform, 'Linux armv8l');
assert.equal(actual.code.id, 'sample/main');
assert.equal(actual.code.sha256, 'a'.repeat(64));
assert.match(actual.revision, /^v1-/);
console.log('Browser core and profile compilation run without Node globals, extension APIs or native host.');
