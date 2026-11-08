#!/usr/bin/env node
/**
 * Build script for @mearl/native-host
 *
 * Bundles src/index.ts into a single standalone dist/index.js using esbuild.
 * The output is a self-contained executable that can be registered as a
 * Chrome Native Messaging Host.
 */

import * as esbuild from 'esbuild';
import { writeBundleNotices } from '../../scripts/bundle-notices.mjs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chmodSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const sharedOptions = {
  bundle: true,
  absWorkingDir: __dirname,
  metafile: true,
  platform: 'node',
  format: 'esm',
  target: 'node20.18',
  charset: 'utf8',
  packages: 'bundle',
  minifySyntax: true,
  minifyWhitespace: true,
  banner: {
    js: `import { createRequire as __mearlCreateRequire } from 'node:module'; const require = __mearlCreateRequire(import.meta.url);`,
  },
  define: {
    __NATIVE_HOST_VERSION__: JSON.stringify(pkg.version),
  },
  external: [
    'node:net',
    'node:fs',
    'node:os',
    'node:path',
    'node:process',
    'node:child_process',
    'node:url',
    'node:module',
    'node:readline',
    'node:stream',
    'ws',
  ],
};

const builds = await Promise.all([
  esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(__dirname, 'src/index.ts')],
    outfile: resolve(__dirname, 'dist/index.js'),
  }),
  esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(__dirname, 'src/node-capabilities.ts')],
    outfile: resolve(__dirname, 'dist/node-capabilities.js'),
  }),
  esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(__dirname, 'src/install.ts')],
    outfile: resolve(__dirname, 'dist/install.js'),
  }),
  esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(__dirname, '../client/src/plugin-worker.ts')],
    outfile: resolve(__dirname, 'dist/plugin-worker.js'),
  }),
  esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(__dirname, '../client/src/plugin-task-host.ts')],
    outfile: resolve(__dirname, 'dist/plugin-task-host.js'),
  }),
  esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(__dirname, '../client/src/pluginModelSessionWorker.ts')],
    outfile: resolve(__dirname, 'dist/pluginModelSessionWorker.js'),
  }),
]);

writeBundleNotices(builds.map(result => result.metafile), __dirname, resolve(__dirname, 'dist/THIRD_PARTY_NOTICES.txt'));
const runtimeBuild = builds[0];

const forbiddenRuntimeImports = Object.values(runtimeBuild.metafile.outputs)
  .flatMap(output => output.imports)
  .map(entry => entry.path)
  .filter(path =>
    /^@mearl\/(browser-core|app-profiles)(\/|$)/.test(
      path,
    ),
  );
if (forbiddenRuntimeImports.length > 0) {
  throw new Error(
    `Native Host runtime dependencies escaped the bundle: ${forbiddenRuntimeImports.join(', ')}`,
  );
}

for (const file of ['dist/index.js', 'dist/install.js']) {
  try {
    chmodSync(resolve(__dirname, file), 0o755);
  } catch {
    // Windows — skip chmod
  }
}

// Generate .d.ts declarations so other workspace packages can import types.
execSync('tsc --emitDeclarationOnly --declaration --outDir dist', {
  cwd: __dirname,
  stdio: 'inherit',
});

console.log('[native-host] Built runtime, installer and plugin executor (with .d.ts)');
