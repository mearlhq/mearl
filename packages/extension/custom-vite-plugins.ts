import fs from 'fs';
import { resolve, dirname } from 'path';
import type { PluginOption } from 'vite';
import { build } from 'vite';
import { APP_PROFILE_RUNTIME_ASSET } from './src/shared/appProfileRuntimeAsset';

/** 单独生成 classic script，供 manifest 同步加载以及后台读取 CDP 注入源码。 */
export function emitAppProfileRuntime(): PluginOption {
  return {
    name: 'emit-app-profile-runtime',
    apply: 'build',
    async buildStart() {
      const result = await build({
        configFile: false,
        root: __dirname,
        publicDir: false,
        logLevel: 'silent',
        build: {
          write: false,
          sourcemap: false,
          lib: {
            entry: resolve(__dirname, 'src/pages/content-script/app-profile-runtime.ts'),
            formats: ['iife'],
            name: 'MearlAppProfileRuntime',
          },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      if (outputs.length !== 1 || !('output' in outputs[0])) {
        throw new Error('App profile runtime build did not produce a single bundle');
      }
      const chunks = outputs[0].output.filter(output => output.type === 'chunk');
      if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) {
        throw new Error('App profile runtime asset must be a self-contained classic script');
      }
      this.emitFile({ type: 'asset', fileName: APP_PROFILE_RUNTIME_ASSET, source: chunks[0].code });
    },
  };
}

// plugin to remove dev icons from prod build
export function stripDevIcons (isDev: boolean) {
  if (isDev) return null

  return {
    name: 'strip-dev-icons',
    resolveId (source: string) {
      return source === 'virtual-module' ? source : null
    },
    renderStart (outputOptions: any, inputOptions: any) {
      const outDir = outputOptions.dir
      fs.rm(resolve(outDir, 'dev-icon-32.png'), () => console.log(`Deleted dev-icon-32.png from prod build`))
      fs.rm(resolve(outDir, 'dev-icon-128.png'), () => console.log(`Deleted dev-icon-128.png from prod build`))
    }
  }
}

// plugin to support i18n
export function crxI18n (options: { localize: boolean, src: string }): PluginOption {
  if (!options.localize) return null

  const getJsonFiles = (dir: string): Array<string> => {
    const files = fs.readdirSync(dir, {recursive: true}) as string[]
    return files.filter(file => !!file && file.endsWith('.json'))
  }
  const entry = resolve(__dirname, options.src)
  const localeFiles = getJsonFiles(entry)
  const files = localeFiles.map(file => {
    return {
      id: '',
      fileName: file,
      source: fs.readFileSync(resolve(entry, file))
    }
  })
  return {
    name: 'crx-i18n',
    enforce: 'pre',
    buildStart: {
      order: 'post',
      handler() {
        files.forEach((file) => {
            const refId = this.emitFile({
              type: 'asset',
              source: file.source,
              fileName: '_locales/'+file.fileName
            })
            file.id = refId
        })
      }
    }
  }
}

// plugin to wrap MAIN-world injected scripts in an IIFE to avoid variable
// conflicts with the host page's own globals (and with other extension
// versions installed simultaneously). Rollup emits imported helpers as bare
// top-level declarations, which become real `window` properties in the
// shared MAIN world if left unwrapped — e.g. `function e(){...}` (generateId)
// gets silently overwritten by the host page's own minified `e`, causing
// `TypeError: e is not a function` on the next call.
export function wrapInjectedIIFE (): PluginOption {
  return {
    name: 'wrap-injected-iife',
    generateBundle (_: any, bundle: any) {
      for (const chunk of Object.values(bundle) as any[]) {
        if (
          chunk.type === 'chunk' &&
          (chunk.fileName?.endsWith('injected.js') ||
            chunk.fileName?.endsWith('early-inject.js') ||
            chunk.fileName?.endsWith('element-picker-main-runtime.js'))
        ) {
          chunk.code = `;(function(){${chunk.code}})();`;
        }
      }
    }
  }
}

const CLASSIC_CONTENT_SCRIPT_OUTPUTS = [
  'src/pages/content-script/early-inject.js',
  'src/pages/content-script/index.js',
  'src/pages/content-script/element-picker-main-runtime.js',
];

// Manifest registration and chrome.scripting.executeScript load these fixed-path
// bundles as classic scripts, so every dependency must be included in the entry chunk.
export function validateClassicContentScripts (): PluginOption {
  return {
    name: 'validate-classic-content-scripts',
    apply: 'build',
    generateBundle (_, bundle) {
      for (const fileName of CLASSIC_CONTENT_SCRIPT_OUTPUTS) {
        const output = bundle[fileName];
        if (output?.type !== 'chunk' || output.imports.length === 0) continue;

        throw new Error(
          `${fileName} must be self-contained, but imports ${output.imports.join(', ')}`,
        );
      }
    },
  };
}

/**
 * CRXJS 会把 manifest content_scripts 改写成动态 import loader。Chrome 130+
 * 会按 content script 所在 world 的 CSP 校验这次 import，导致 loader 无法加载。
 * 这些入口已经由 Rollup 输出为固定路径的自包含 classic script，因此在 CRXJS
 * 完成其余 manifest 转换后直接写回声明即可。
 */
export function restoreClassicContentScripts (
  contentScripts: readonly unknown[],
): PluginOption {
  return {
    name: 'restore-classic-content-scripts',
    enforce: 'post',
    renderCrxManifest (manifest: Record<string, unknown>) {
      return { ...manifest, content_scripts: contentScripts }
    },
  } as PluginOption
}

const TOOLBOX_PREACT_RUNTIME_ASSET = 'plugin/toolbox-preact-runtime.js';

function browserRuntimeSource(path: string): string {
  return fs.readFileSync(path, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
}

export function emitToolboxPreactRuntime(): PluginOption {
  const preactRoot = resolve(__dirname, 'node_modules/preact');
  const htmRoot = resolve(__dirname, 'node_modules/htm');
  const preactPackage = JSON.parse(
    fs.readFileSync(resolve(preactRoot, 'package.json'), 'utf8'),
  ) as { version: string };
  const source = [
    browserRuntimeSource(resolve(preactRoot, 'dist/preact.min.umd.js')),
    browserRuntimeSource(resolve(preactRoot, 'hooks/dist/hooks.umd.js')),
    browserRuntimeSource(resolve(htmRoot, 'dist/htm.umd.js')),
    `;(() => {
  const preactRuntime = globalThis.preact;
  const preactHooksRuntime = globalThis.preactHooks;
  const htmRuntime = globalThis.htm;
  if (!preactRuntime || !preactHooksRuntime || typeof htmRuntime !== 'function') {
    throw new Error('Mearl toolbox Preact runtime failed to initialize');
  }
  const ui = Object.freeze({
    ...preactRuntime,
    ...preactHooksRuntime,
    html: htmRuntime.bind(preactRuntime.h),
    runtime: 'preact',
    version: ${JSON.stringify(preactPackage.version)},
  });
  Object.defineProperty(globalThis, '__mearlToolboxUi', {
    configurable: true,
    enumerable: false,
    value: ui,
  });
  for (const name of ['preact', 'preactHooks', 'htm']) {
    try {
      delete globalThis[name];
    } catch {}
  }
})();`,
  ].join('\n');

  return {
    name: 'emit-toolbox-preact-runtime',
    apply: 'build',
    buildStart() {
      this.emitFile({
        type: 'asset',
        fileName: TOOLBOX_PREACT_RUNTIME_ASSET,
        source,
      });
    },
  };
}
