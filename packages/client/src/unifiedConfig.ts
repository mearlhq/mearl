import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MEARL_CONFIG_DIR = join(homedir(), '.mearl');

export interface CloudServerConfig {
  server: string;
}

/** Number of local calendar days between CLI update checks; null disables them. */
export function loadCliAutoUpdateIntervalDays(
  configPath = join(MEARL_CONFIG_DIR, 'config.json'),
): number | null {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      cliAutoUpdate?: unknown;
    };
    if (config.cliAutoUpdate === false) return null;
    if (config.cliAutoUpdate === undefined) return 1;
    if (
      typeof config.cliAutoUpdate === 'object' &&
      config.cliAutoUpdate !== null &&
      !Array.isArray(config.cliAutoUpdate)
    ) {
      const { intervalDays } = config.cliAutoUpdate as { intervalDays?: unknown };
      if (
        typeof intervalDays === 'number' &&
        Number.isSafeInteger(intervalDays) &&
        intervalDays > 0
      )
        return intervalDays;
    }
  } catch {
    // A missing or invalid config uses the daily default.
  }
  return 1;
}

export function getCloudServerConfigPath(): string {
  return join(MEARL_CONFIG_DIR, 'cloud-server.json');
}

export function loadCloudServerConfig(): CloudServerConfig | null {
  try {
    const configPath = getCloudServerConfigPath();
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { server?: unknown };
    return typeof config.server === 'string' && config.server.trim()
      ? { server: config.server }
      : null;
  } catch {
    return null;
  }
}

export function loadLocalConnectorId(): string | null {
  const explicit = process.env.MEARL_CONNECTOR_ID?.trim();
  if (explicit) return explicit;
  try {
    const config = JSON.parse(
      readFileSync(join(MEARL_CONFIG_DIR, 'cloud-connector-identity.json'), 'utf8'),
    ) as { connectorId?: unknown };
    return typeof config.connectorId === 'string' && config.connectorId.trim()
      ? config.connectorId
      : null;
  } catch {
    return null;
  }
}

export function resolveServer(explicit?: string): { serverUrl?: string; serverUrlSource?: string } {
  if (explicit) return { serverUrl: explicit, serverUrlSource: '--server' };
  if (process.env.MEARL_SERVER_URL) {
    return { serverUrl: process.env.MEARL_SERVER_URL, serverUrlSource: 'MEARL_SERVER_URL' };
  }
  const config = loadCloudServerConfig();
  return config?.server
    ? { serverUrl: config.server, serverUrlSource: getCloudServerConfigPath() }
    : {};
}
