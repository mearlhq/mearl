import { supervisePluginExecutor } from './plugins/runtime/pluginExecutorSupervisor.js';
import type { PluginWorkerRequest } from './plugins/runtime/pluginExecutorProtocol.js';

if (process.argv[2] === '--command') {
  let command: Promise<typeof import('./plugins/runtime/pluginCommandWorker.js')> | undefined;
  // Register IPC before loading command code so startup messages retain their order.
  process.on('message', (message: PluginWorkerRequest) => {
    void (command ??= import('./plugins/runtime/pluginCommandWorker.js'))
      .then(worker => worker.handlePluginWorkerMessage(message))
      .catch(error => {
        process.stderr.write(String(error));
        process.exit(1);
      });
  });
  process.on('disconnect', () => process.exit(1));
} else {
  supervisePluginExecutor(import.meta.url);
}
