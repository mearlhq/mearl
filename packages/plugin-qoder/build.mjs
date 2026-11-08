import { build } from 'esbuild';
import { writeBundleNotices } from '../../scripts/bundle-notices.mjs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['src/runtime.ts'], bundle: true, write: false, metafile: true,
  platform: 'node', format: 'cjs', target: 'node20.18',
  footer: { js: 'module.exports = module.exports.default;' },
});
const bytes = result.outputFiles[0].contents;
const manifest = {
  schemaVersion: 1, id: 'qoder', version: '1.0.0', requires: { mearlApi: '^1' },
  resources: { 'runtime.cjs': { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length } },
  contributions: { appProfiles: [], nodeRuntimes: { 'native-host': { entry: 'runtime.cjs', bindings: {
    'agent.provider.qoder': 'agent', 'cloud.connector.qoder': 'connector', 'cloud.server.qoder': 'server',
  } } } },
};
await mkdir('dist/capability', { recursive: true });
await writeFile('dist/capability/runtime.cjs', bytes);
await writeFile('dist/capability/bundle.json', JSON.stringify(manifest, null, 2) + '\n');
await writeFile('dist/capability/preset.json', JSON.stringify({
  schemaVersion: 1, id: 'qoder', version: '1.0.0', packages: { qoder: { source: './bundle.json', version: '^1', targets: ['node'] } },
}, null, 2) + '\n');
await chmod('dist/cli.js', 0o755);
writeBundleNotices([result.metafile], process.cwd(), resolve('dist/THIRD_PARTY_NOTICES.txt'));
