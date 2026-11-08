import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { hashKey, keyedDir, rotateLogIfNeeded } from '@mearl/daemon-core';
import {
  PROVIDER_START_TOKEN_ENV,
  claimProviderStart,
  listInstalledProviders,
  listLiveProviders,
  readLiveProvider,
  readProviderStart,
  releaseProviderStart,
  transferProviderStart,
  validateInstalledProviderManifest,
} from './registry.js';
import type { InstalledProviderManifest } from './types.js';
import { assertProviderProtocolVersion } from './protocol.js';

export const PROVIDER_LOGS_SUBDIR = 'providers/logs';

function providerLogFile(providerId: string): string {
  const hash = hashKey(providerId);
  return join(keyedDir(PROVIDER_LOGS_SUBDIR), `${hash}.log`);
}

function hasCompatibleLiveProvider(providerId: string): boolean {
  const live = readLiveProvider(providerId);
  if (!live) return false;
  assertProviderProtocolVersion(live.providerProtocolVersion, providerId);
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function spawnProvider(
  manifest: InstalledProviderManifest,
  logFile: string,
  startToken: string,
): Promise<number> {
  mkdirSync(keyedDir(PROVIDER_LOGS_SUBDIR), { recursive: true, mode: 0o700 });
  rotateLogIfNeeded(logFile);
  const output = openSync(logFile, 'a');
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [manifest.entryPath], {
        cwd: manifest.packageRoot,
        env: {
          ...process.env,
          [PROVIDER_START_TOKEN_ENV]: startToken,
        },
        detached: true,
        stdio: ['ignore', output, output],
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.removeAllListeners('error');
        child.on('error', () => {});
        child.unref();
        if (child.pid) resolve(child.pid);
        else reject(new Error('spawned process has no pid'));
      });
    });
  } finally {
    closeSync(output);
  }
}

/** Start explicitly installed on-demand providers before browser discovery. */
export async function ensureInstalledProvidersRunning(
  providerIds?: readonly string[],
): Promise<string[]> {
  const warnings: string[] = [];
  const selected = providerIds ? new Set(providerIds) : undefined;
  const installed = listInstalledProviders().filter(
    provider => !selected || selected.has(provider.providerId),
  );
  const starting = new Map<string, string | null>();

  for (const manifest of installed) {
    const invalid = validateInstalledProviderManifest(manifest);
    if (invalid) {
      warnings.push(`provider ${manifest.providerId || '(unknown)'}: ${invalid}`);
      continue;
    }
    let startToken: string | undefined;
    try {
      if (hasCompatibleLiveProvider(manifest.providerId)) continue;
      startToken = randomUUID();
      if (!claimProviderStart(manifest.providerId, startToken)) {
        if (hasCompatibleLiveProvider(manifest.providerId)) continue;
        if (readProviderStart(manifest.providerId)) starting.set(manifest.providerId, null);
        else warnings.push(`provider ${manifest.providerId}: failed to acquire startup ownership`);
        continue;
      }
      if (hasCompatibleLiveProvider(manifest.providerId)) {
        releaseProviderStart(manifest.providerId, startToken);
        continue;
      }
      const logFile = providerLogFile(manifest.providerId);
      const childPid = await spawnProvider(manifest, logFile, startToken);
      transferProviderStart(manifest.providerId, startToken, childPid);
      starting.set(manifest.providerId, startToken);
    } catch (error) {
      if (startToken) releaseProviderStart(manifest.providerId, startToken);
      warnings.push(
        `provider ${manifest.providerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (starting.size === 0) return warnings;
  const startupTimeout = (providerId: string) =>
    installed.find(manifest => manifest.providerId === providerId)?.browserType.controlSessionModes?.includes('external')
      ? 12_000 : 2_000;
  const deadlines = new Map([...starting.keys()].map(id => [id, Date.now() + startupTimeout(id)]));
  const remaining = new Set(starting.keys());
  const waiting = new Set(starting.keys());
  while (waiting.size > 0) {
    await delay(100);
    const current = new Set(listLiveProviders().map(record => record.providerId));
    for (const providerId of waiting) {
      if (current.has(providerId)) {
        waiting.delete(providerId);
        remaining.delete(providerId);
      } else if (Date.now() >= deadlines.get(providerId)!) {
        waiting.delete(providerId);
      }
    }
  }
  for (const [providerId, token] of starting) {
    if (!remaining.has(providerId) && token) releaseProviderStart(providerId, token);
    if (!remaining.has(providerId)) {
      try {
        hasCompatibleLiveProvider(providerId);
      } catch (error) {
        warnings.push(
          `provider ${providerId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  for (const providerId of remaining) {
    const logFile = providerLogFile(providerId);
    warnings.push(
      `provider ${providerId}: did not become ready within ${startupTimeout(providerId) / 1000}s${existsSync(logFile) ? `; see ${logFile}` : ''}`,
    );
  }
  // A ready provider may still be publishing its first browser inventory.
  await delay(100);
  return warnings;
}
