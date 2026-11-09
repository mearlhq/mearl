import { extensionManifestVersion } from '@mearl/browser-core';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'path';
import { ManifestV3Export } from '@crxjs/vite-plugin';
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, BuildOptions } from 'vite';
import { stripDevIcons, crxI18n, wrapInjectedIIFE, validateClassicContentScripts, emitToolboxPreactRuntime, emitAppProfileRuntime } from './custom-vite-plugins';
import manifest, { customWebsite } from './manifest';
import pkg from './package.json';

const isDev = process.env.__DEV__ === 'true';
// set this flag to true, if you want localization support
const localize = true;

export const baseManifest = {
    ...manifest,
    ...extensionManifestVersion(pkg.version),
    ...(localize ? {
      name: '__MSG_extName__',
      description: '__MSG_extDescription__',
      default_locale : 'en'
    } : {})
} as ManifestV3Export

export const baseBuildOptions: BuildOptions = {
  sourcemap: isDev,
  emptyOutDir: !isDev,
  // DevTools extension pages load modules in a different world from their HTML
  // preload scanner, so generated modulepreload links are always discarded.
  modulePreload: false,
}

export default defineConfig({
  define: {
    __MEARL_BUILD_CHANNEL__: JSON.stringify(isDev ? 'development' : 'production'),
    __MEARL_WEBSITE_URL__: JSON.stringify(customWebsite?.href ?? ''),
  },
  resolve: {
    tsconfigPaths: true,
    alias: {
      'react-dom/test-utils': fileURLToPath(import.meta.resolve('preact/test-utils')),
      'react-dom/client': fileURLToPath(import.meta.resolve('preact/compat/client')),
      'react/jsx-dev-runtime': fileURLToPath(import.meta.resolve('preact/jsx-dev-runtime')),
      'react/jsx-runtime': fileURLToPath(import.meta.resolve('preact/jsx-runtime')),
      'react-dom': fileURLToPath(import.meta.resolve('preact/compat')),
      react: fileURLToPath(import.meta.resolve('preact/compat')),
      'preact/compat/client': fileURLToPath(import.meta.resolve('preact/compat/client')),
      'preact/compat': fileURLToPath(import.meta.resolve('preact/compat')),
      'preact/jsx-dev-runtime': fileURLToPath(import.meta.resolve('preact/jsx-dev-runtime')),
      'preact/jsx-runtime': fileURLToPath(import.meta.resolve('preact/jsx-runtime')),
      'preact/test-utils': fileURLToPath(import.meta.resolve('preact/test-utils')),
    },
  },
  plugins: [
    tailwindcss(),
    preact({ reactAliasesEnabled: false }),
    emitAppProfileRuntime(),
    emitToolboxPreactRuntime(),
    stripDevIcons(isDev),
    crxI18n({ localize, src: './src/locales' }),
    wrapInjectedIIFE(),
    validateClassicContentScripts(),
  ],
  publicDir: resolve(__dirname, 'public'),
});
