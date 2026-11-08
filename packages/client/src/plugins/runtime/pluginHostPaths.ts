import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginDirectory } from '../pluginRegistry.js';

export function pluginHostPaths() {
  const registry = pluginDirectory();
  const key = createHash('sha256').update(registry).digest('hex').slice(0, 16);
  const home = join(registry, '.host');
  return {
    registry,
    home,
    lease: join(home, 'service.json'),
    log: join(home, 'service.log'),
    installations: join(home, 'installations'),
    revisions: join(home, 'revisions'),
    tasks: join(home, 'tasks'),
    state: join(home, 'state'),
    socket:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\mearl-plugin-${key}`
        : join(tmpdir(), `mp-${key}.sock`),
  };
}
