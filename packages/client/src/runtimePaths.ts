import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const CLIENT_VERSION: string = (require('../package.json') as { version: string }).version;

// SDK bundles resolve the task service from the installed Client package on demand.
export function resolvePluginTaskHostPath(): string {
  return require.resolve('@mearl/client/plugin-task-host');
}

export const PLUGIN_WORKER_PATH = fileURLToPath(new URL('./plugin-worker.js', import.meta.url));
export const SCRIPT_WORKER_PATH = fileURLToPath(new URL('./scriptWorker.js', import.meta.url));
export const PLUGIN_MODEL_SESSION_WORKER_PATH = fileURLToPath(
  new URL('./pluginModelSessionWorker.js', import.meta.url),
);
