import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Package metadata and process entries share this anchor in compiled and bundled hosts.
const require = createRequire(import.meta.url);
export const CLIENT_VERSION: string = (require('../package.json') as { version: string }).version;
export const PLUGIN_TASK_HOST_PATH = fileURLToPath(
  new URL('./plugin-task-host.js', import.meta.url),
);
export const PLUGIN_WORKER_PATH = fileURLToPath(new URL('./plugin-worker.js', import.meta.url));
export const SCRIPT_WORKER_PATH = fileURLToPath(new URL('./scriptWorker.js', import.meta.url));
export const PLUGIN_MODEL_SESSION_WORKER_PATH = fileURLToPath(
  new URL('./pluginModelSessionWorker.js', import.meta.url),
);
