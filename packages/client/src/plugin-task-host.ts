import { startPluginHostServer } from './plugins/runtime/pluginHostServer.js';

try {
  const server = await startPluginHostServer();
  const close = () => {
    void server.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
} catch (error) {
  if ((error as { code?: string }).code !== 'PLUGIN_TASK_HOST_OWNED')
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = (error as { code?: string }).code === 'PLUGIN_TASK_HOST_OWNED' ? 0 : 1;
}
