import { resolve } from 'path';
import { mergeConfig, defineConfig } from 'vite';
import { crx, ManifestV3Export } from '@crxjs/vite-plugin';
import baseConfig, { baseManifest, baseBuildOptions } from './vite.config.base'
import { restoreClassicContentScripts } from './custom-vite-plugins';

const outDir = resolve(__dirname, 'dist_chrome');
type StaticManifestV3 = Extract<ManifestV3Export, { manifest_version: number }>;
const staticManifest = baseManifest as StaticManifestV3;
const classicContentScripts = staticManifest.content_scripts ?? [];
const crxManifest = { ...staticManifest };
delete crxManifest.content_scripts;

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      crx({
        manifest: crxManifest,
        browser: 'chrome',
      }),
      restoreClassicContentScripts(classicContentScripts),
    ],
    build: {
      ...baseBuildOptions,
      outDir,
      rollupOptions: {
        input: {
          panel: resolve(__dirname, 'src/pages/panel/index.html'),
          popup: resolve(__dirname, 'src/pages/popup/index.html'),
          sidepanel: resolve(__dirname, 'src/pages/sidepanel/index.html'),
          'device-capture': resolve(__dirname, 'src/pages/device-capture/index.html'),
          'device-preview-panel': resolve(__dirname, 'src/pages/device-preview-panel/index.html'),
          plugin: resolve(__dirname, 'plugin/index.html'),
          'plugin-sandbox': resolve(__dirname, 'plugin/sandbox.html'),
          'chat-visualization': resolve(__dirname, 'plugin/visualization.html'),
          'permission-request': resolve(__dirname, 'src/pages/permission-request/index.html'),
          installation: resolve(__dirname, 'src/pages/installation/index.html'),
          'browser-transport': resolve(__dirname, 'src/pages/browser-transport/index.html'),
          offscreen: resolve(__dirname, 'src/pages/offscreen/index.html'),
          'content-script': resolve(__dirname, 'src/pages/content-script/index.ts'),
          'early-inject': resolve(__dirname, 'src/pages/content-script/early-inject.ts'),
          'element-picker-main-runtime': resolve(
            __dirname,
            'src/pages/content-script/elementPickerMainRuntime.ts',
          ),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            // content-script 动态注入脚本输出到固定路径
            if (chunkInfo.name === 'content-script') {
              return 'src/pages/content-script/index.js';
            }
            // early-inject 脚本输出到指定位置
            if (chunkInfo.name === 'early-inject') {
              return 'src/pages/content-script/early-inject.js';
            }
            if (chunkInfo.name === 'element-picker-main-runtime') {
              return 'src/pages/content-script/element-picker-main-runtime.js';
            }
            return 'assets/[name]-[hash].js';
          },
        }
      }
    },
  })
)
