import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import { parseInstallationConfig } from './src/lib/installation.mjs';
import { referenceLinksPlugin } from './src/lib/reference-links.mjs';

const site = JSON.parse(readFileSync(new URL('../preset/installation-site.json', import.meta.url), 'utf8')).url;
const siteUrl = new URL(site);
if (siteUrl.protocol !== 'https:' || siteUrl.username || siteUrl.password || siteUrl.search || siteUrl.hash || !siteUrl.pathname.endsWith('/')) {
  throw new Error('Installation site must be an HTTPS directory URL');
}
const configFile = process.env.MEARL_INSTALLATION_CONFIG_FILE;
const source = configFile ? readFileSync(configFile) : Buffer.from('{"schemaVersion":1}');
if (source.byteLength > 65_536) throw new Error('Installation configuration is too large');
const installation = parseInstallationConfig(JSON.parse(source.toString('utf8')), siteUrl.origin);

export default defineConfig({
  site: siteUrl.origin,
  base: siteUrl.pathname,
  devToolbar: { enabled: false },
  output: 'static',
  markdown: {
    processor: satteri({ hastPlugins: [referenceLinksPlugin(siteUrl.pathname)] }),
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } },
  },
  build: { format: 'file', inlineStylesheets: 'always' },
  integrations: [{
    name: 'mearl-installation-config',
    hooks: {
      'astro:build:done': ({ dir }) => {
        writeFileSync(new URL('installation.json', dir), `${JSON.stringify(installation, null, 2)}\n`);
      },
      'astro:server:setup': ({ server }) => {
        server.middlewares.use('/installation.json', (_request, response) => {
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(installation));
        });
      },
    },
  }],
});
