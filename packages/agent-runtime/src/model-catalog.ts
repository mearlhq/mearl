import { CodexAgentProvider } from './codex-provider.js';
import type { PluginModelOption } from '@mearl/browser-core/pluginModels';
import { readFileSync } from 'node:fs';

/** Discovery starts no thread and always releases its short-lived app-server. */
export async function listCodexModels(
  signal: AbortSignal,
  provider = new CodexAgentProvider(
    () => {},
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  ),
): Promise<PluginModelOption[]> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      provider.dispose();
      reject(signal.reason ?? new Error('Model discovery cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([provider.listModels(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
    provider.dispose();
  }
}
