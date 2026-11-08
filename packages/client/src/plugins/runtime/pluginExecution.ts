import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginDirectory } from '../pluginRegistry.js';
import type {
  PluginExecutionHost,
  PluginInvocationIdentity,
  PluginInvocationSource,
} from '@mearl/browser-core';
import type { PluginApp } from '../sdk/plugin.js';
import type { PluginTaskRecoveryContext } from '@mearl/browser-core';

export type { PluginExecutionHost, PluginInvocationIdentity, PluginInvocationSource };

export interface PluginCommandContext extends Pick<PluginApp, 'invoke' | 'progress'> {
  readonly identity: Readonly<PluginInvocationIdentity>;
  readonly signal: AbortSignal;
  readonly state: PluginApp['state'];
  readonly model: PluginApp['model'];
  readonly recovery?: Readonly<PluginTaskRecoveryContext>;
  readonly checkpoint: PluginApp['checkpoint'];
  readonly page?: {
    send(message: unknown, options?: { timeoutSec?: number }): Promise<unknown>;
    get(): Promise<unknown>;
  };
}

const epoch = randomUUID();
const hostIds = new Map<string, string>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Exclusive creation gives concurrent browser processes the same environment identity. */
export function localPluginExecutionHost(): PluginExecutionHost {
  const directory = pluginDirectory();
  let hostId = hostIds.get(directory);
  if (!hostId) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, '.execution-host-id');
    const proposed = randomUUID();
    const temporary = `${file}.${proposed}.tmp`;
    try {
      writeFileSync(temporary, proposed, { flag: 'wx', mode: 0o600 });
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
    hostId = readFileSync(file, 'utf8').trim();
    if (!UUID.test(hostId)) throw new Error('Invalid plugin execution host identity');
    hostIds.set(directory, hostId);
  }
  return Object.freeze({ hostId, epoch });
}

export function createPluginInvocationIdentity(
  plugin: string,
  source: PluginInvocationSource,
  parent?: PluginInvocationIdentity,
): PluginInvocationIdentity {
  return Object.freeze({
    invocationId: randomUUID(),
    host: parent?.host ?? localPluginExecutionHost(),
    plugin,
    source,
    ...(parent ? { parentInvocationId: parent.invocationId } : {}),
  });
}
