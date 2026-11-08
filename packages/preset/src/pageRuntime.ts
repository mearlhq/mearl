/** A content-addressed MAIN world installer, delivered through a prepared debugger bootstrap. */
export interface PageRuntimeBinding {
  id: string;
  sha256: string;
}

export interface PageRuntimeConfig {
  pageRuntime?: PageRuntimeBinding;
}

type Installer = (config: PageRuntimeConfig) => void;
interface PageRuntimeHost {
  install<Config extends PageRuntimeConfig>(config: Config, fallback?: (config: Config) => void): void;
  register(sha256: string, installer: Installer): void;
}

/** Self-contained because the debugger serializes this function into each document. */
export function installPageRuntimeHost(): PageRuntimeHost {
  const root = window as unknown as { __mearlPageRuntimeHost__?: PageRuntimeHost };
  if (root.__mearlPageRuntimeHost__) return root.__mearlPageRuntimeHost__;
  const installers = new Map<string, Installer>();
  const pending = new Map<string, PageRuntimeConfig[]>();
  const host: PageRuntimeHost = {
    install(config, fallback) {
      const binding = config.pageRuntime;
      if (!binding) { fallback?.(config); return; }
      const installer = installers.get(binding.sha256);
      if (installer) { installer(config); return; }
      const waiting = pending.get(binding.sha256) ?? [];
      waiting.push(config);
      pending.set(binding.sha256, waiting);
    },
    register(sha256, installer) {
      if (typeof installer !== 'function') throw new Error('A page runtime must export an install function');
      if (installers.has(sha256)) return;
      installers.set(sha256, installer);
      const waiting = pending.get(sha256) ?? [];
      pending.delete(sha256);
      for (const config of waiting) installer(config);
    },
  };
  Object.defineProperty(root, '__mearlPageRuntimeHost__', { configurable: true, value: host });
  return host;
}

/** The returned source is executed only in the controlled page, never in the extension host. */
export function buildPageRuntimeRegistrationSource(binding: PageRuntimeBinding, source: string, installerGlobal: string): string {
  if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(binding.id) || !/^[a-f0-9]{64}$/.test(binding.sha256) || !source.trim()) throw new Error('Invalid page runtime binding');
  return `;(() => { const host=(${installPageRuntimeHost.toString()})(); const module={exports:{}};\n(function(module,exports){\n${source}\n})(module,module.exports);\nhost.register(${JSON.stringify(binding.sha256)},module.exports.install); Object.defineProperty(window,${JSON.stringify(installerGlobal)},{configurable:true,value:config=>host.install(config)}); })();`;
}

export function buildPageRuntimeCallSource(configExpression: string): string {
  return `(${installPageRuntimeHost.toString()})().install(${configExpression});`;
}
