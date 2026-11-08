import type { PluginModelList, PluginModelOption } from '@mearl/browser-core';

/** A bounded shared lookup avoids starting a discovery process for each open tool. */
export class PluginModelCatalog {
  private readonly controller = new AbortController();
  private cached?: { value: PluginModelList; expires: number };
  private pending?: Promise<PluginModelList>;
  constructor(
    private readonly discover: (
      signal: AbortSignal,
    ) => Promise<PluginModelOption[]> = async signal => {
      const { listCodexModels } = await import('@mearl/agent-runtime/codex');
      return listCodexModels(signal);
    },
    private readonly now = Date.now,
  ) {}
  list(provider: unknown = 'codex'): Promise<PluginModelList> {
    this.controller.signal.throwIfAborted();
    if (provider !== 'codex') throw new Error('Unsupported model provider');
    if (this.cached) {
      if (this.cached.expires <= this.now()) void this.refresh().catch(() => {});
      return Promise.resolve(structuredClone(this.cached.value));
    }
    return this.refresh().then(value => structuredClone(value));
  }
  private refresh(): Promise<PluginModelList> {
    this.pending ??= this.load()
      .catch(error => {
        // A failed refresh keeps the last usable catalog and bounds repeat discovery.
        if (this.cached) this.cached.expires = this.now() + 30000;
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async load(): Promise<PluginModelList> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]);
    const value = { provider: 'codex', models: await this.discover(signal) };
    signal.throwIfAborted();
    this.cached = { value, expires: this.now() + 120000 };
    return value;
  }
  async close(): Promise<void> {
    this.controller.abort();
    await this.pending?.catch(() => {});
    this.cached = undefined;
  }
}
