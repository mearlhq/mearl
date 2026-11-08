import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MODE_FILE } from './paths.js';

export type CloudServerMode = string;

export const CLOUD_SERVER_MODE_ENV = 'MEARL_CLOUD_MODE';

interface CloudServerModeStorage {
  modeFile?: string;
  readText?: (filePath: string) => string;
  removeFile?: (filePath: string) => void;
  writeText?: (filePath: string, value: string) => void;
}

function isCloudServerMode(value: unknown): value is CloudServerMode {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function readStoredMode(storage: CloudServerModeStorage): CloudServerMode | null {
  const modeFile = storage.modeFile ?? MODE_FILE;
  const readText = storage.readText ?? (filePath => readFileSync(filePath, 'utf8'));
  try {
    const value = JSON.parse(readText(modeFile)) as { mode?: unknown };
    return isCloudServerMode(value.mode) ? value.mode : null;
  } catch {
    return null;
  }
}

function writeStoredMode(mode: CloudServerMode, storage: CloudServerModeStorage): void {
  const modeFile = storage.modeFile ?? MODE_FILE;
  const writeText =
    storage.writeText ??
    ((filePath, value) => {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 });
    });
  writeText(modeFile, `${JSON.stringify({ mode })}\n`);
}

function clearStoredMode(storage: CloudServerModeStorage): void {
  const modeFile = storage.modeFile ?? MODE_FILE;
  const removeFile = storage.removeFile ?? (filePath => rmSync(filePath, { force: true }));
  removeFile(modeFile);
}

export function resolveCloudServerMode(
  env: NodeJS.ProcessEnv = process.env,
  storage: CloudServerModeStorage = {},
): CloudServerMode {
  const requested = env[CLOUD_SERVER_MODE_ENV];
  if (requested !== undefined) {
    if (!isCloudServerMode(requested)) {
      throw new Error(`${CLOUD_SERVER_MODE_ENV} must be a valid installed cloud mode ID`);
    }
    if (requested !== 'websocket') writeStoredMode(requested, storage);
    else clearStoredMode(storage);
    return requested;
  }
  return readStoredMode(storage) ?? 'websocket';
}
