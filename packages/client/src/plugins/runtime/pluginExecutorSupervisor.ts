import { execFileSync, fork, type Serializable } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PluginWorkerEvent, PluginWorkerRequest } from './pluginExecutorProtocol.js';

/** Ownership monitoring runs outside the event loop that executes plugin code. */
export function supervisePluginExecutor<
  Request extends Serializable = PluginWorkerRequest,
  Event extends Serializable = PluginWorkerEvent,
>(workerUrl: string): void {
  const child = fork(fileURLToPath(workerUrl), ['--command'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
    execArgv: [],
  });
  let ending = false;
  let forwarded = Promise.resolve();
  child.stderr?.on('data', chunk => process.stderr.write(chunk));
  child.stdout?.on('data', chunk => process.stdout.write(chunk));

  const terminate = () => {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        child.kill('SIGKILL');
      }
    } else {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    process.exit(1);
  };
  process.on('disconnect', terminate);
  process.on('message', (message: Request) => {
    if (!child.connected || ending) return;
    child.send(message, error => {
      if (error && !ending) terminate();
    });
  });
  child.on('message', (message: Event) => {
    forwarded = forwarded.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!process.send || !process.connected) {
            reject(new Error('Plugin owner disconnected'));
            return;
          }
          process.send(message, error => (error ? reject(error) : resolve()));
        }),
    );
    void forwarded.catch(terminate);
  });
  child.once('error', error => {
    process.stderr.write(error.message);
    terminate();
  });
  child.once('exit', code => {
    ending = true;
    child.stderr?.destroy();
    void forwarded.then(() => process.exit(code ?? 1), terminate);
  });
}
