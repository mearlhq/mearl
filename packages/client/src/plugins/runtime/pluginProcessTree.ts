import { execFile } from 'node:child_process';
import { isProcessGroupAlive } from '@mearl/daemon-core';

/** Resolves after the owned process group can no longer execute. */
export async function stopPluginProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid plugin process group');
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      execFile(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 },
        error => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  const deadline = Date.now() + 5000;
  while (isProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) throw new Error('Unable to confirm plugin process group stopped');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
