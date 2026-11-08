import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const resources = {};
for (const platform of ['browser', 'node']) {
  const result = await build({
    entryPoints: ['src/runtime.ts'], bundle: true, write: false,
    platform, format: 'cjs', target: platform === 'browser' ? 'chrome141' : 'node20.18',
    footer: { js: 'module.exports = module.exports.default;' },
  });
  const bytes = result.outputFiles[0].contents;
  const name = `${platform}.cjs`;
  resources[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
  await mkdir('dist/capability', { recursive: true });
  await writeFile(`dist/capability/${name}`, bytes);
}
const manifest = {
  schemaVersion: 1, id: 'tracking', version: '1.0.0', requires: { mearlApi: '^1' }, resources,
  contributions: {
    appProfiles: [],
    nodeRuntimes: { 'native-host': { entry: 'node.cjs', bindings: { 'tracking.request': 'tracking' } } },
    browserRuntimes: { extension: { entry: 'browser.cjs', bindings: { 'tracking.decode': 'decode', 'tracking.spm': 'spm' } } },
  },
};
await writeFile('dist/capability/bundle.json', JSON.stringify(manifest, null, 2) + '\n');
await writeFile('dist/capability/preset.json', JSON.stringify({
  schemaVersion: 1, id: 'tracking', version: '1.0.0', packages: { tracking: { source: './bundle.json', version: '^1', targets: ['node', 'browser'] } },
}, null, 2) + '\n');
