import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface MearlConfig {
  clientId?: string;
  [key: string]: unknown;
}

export const MEARL_CONFIG_FILE = path.join(os.homedir(), '.mearl', 'config.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readMearlConfig(configFile = MEARL_CONFIG_FILE): MearlConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return isRecord(parsed) ? (parsed as MearlConfig) : {};
  } catch {
    return {};
  }
}

export function writeMearlConfig(config: MearlConfig, configFile = MEARL_CONFIG_FILE): void {
  const configDirectory = path.dirname(configFile);
  const temporaryFile = `${configFile}.${process.pid}.tmp`;
  fs.mkdirSync(configDirectory, { recursive: true });
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryFile, configFile);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // The write may have failed before the temporary file was created.
    }
    throw error;
  }
}
