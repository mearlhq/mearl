#!/usr/bin/env node
/**
 * Build script for @mearl/cloud-server
 *
 * Compiles TypeScript and injects version number into CLI using esbuild.
 */

import * as esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, chmodSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

// Shared chunks keep the library and daemon CLI deployable together without
// duplicating the server implementation in both entry files.
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20.18',
  charset: 'utf8',
  packages: 'external',
  define: {
    __CLOUD_SERVER_VERSION__: JSON.stringify(pkg.version),
  },
  external: ['node:*', '@mearl/cloud-types', '@mearl/daemon-core'],
};

await esbuild.build({
  ...shared,
  splitting: true,
  entryPoints: {
    cli: resolve(__dirname, 'src/bin.ts'),
    index: resolve(__dirname, 'src/index.ts'),
  },
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  outdir: resolve(__dirname, 'dist'),
});

// Generate .d.ts for other exports
import { execSync } from 'child_process';
execSync('tsc -p tsconfig.build.json --emitDeclarationOnly --declaration --outDir dist', {
  cwd: __dirname,
  stdio: 'inherit',
});

// Make CLI executable
try {
  chmodSync(resolve(__dirname, 'dist/cli.js'), 0o755);
} catch {
  // Windows — skip chmod
}

console.log('[cloud-server] Built to dist/ (version: ' + pkg.version + ')');
