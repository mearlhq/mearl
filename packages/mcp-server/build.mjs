#!/usr/bin/env node

import * as esbuild from 'esbuild';
import { writeBundleNotices } from '../../scripts/bundle-notices.mjs';
import { execSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = dirname(fileURLToPath(import.meta.url));

execSync('tsc', {
  cwd: packageDir,
  stdio: 'inherit',
});

// The server only uses MCP's stdio transport. Bundling those subpath imports avoids
// installing the SDK's optional HTTP, SSE, and authentication dependency surface.
const runtimeBuild = await esbuild.build({
  bundle: true,
  absWorkingDir: packageDir,
  platform: 'node',
  format: 'esm',
  target: 'node20.18',
  charset: 'utf8',
  packages: 'bundle',
  minifySyntax: true,
  minifyWhitespace: true,
  entryPoints: [resolve(packageDir, 'src/index.ts')],
  outfile: resolve(packageDir, 'dist/index.js'),
  external: [
    'node:*',
    'fs',
    'os',
    'path',
    'child_process',
    'url',
    'module',
    '@mearl/client',
    'commander',
  ],
  metafile: true,
});

writeBundleNotices([runtimeBuild.metafile], packageDir, resolve(packageDir, 'dist/THIRD_PARTY_NOTICES.txt'));

const externalImports = Object.values(runtimeBuild.metafile.outputs)
  .flatMap(output => output.imports)
  .filter(entry => entry.external)
  .map(entry => entry.path);
if (externalImports.some(path => path.startsWith('@modelcontextprotocol/sdk'))) {
  throw new Error('MCP SDK escaped the mcp-server runtime bundle');
}

for (const file of ['dist/index.js', 'dist/configure-bin.js', 'dist/uninstall-bin.js']) {
  chmodSync(resolve(packageDir, file), 0o755);
}

console.log('[mcp-server] Built stdio runtime and CLI declarations to dist/');
