import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemon, type Daemon } from '../daemon.js';

let tempDir: string | null = null;
let daemon: Daemon | null = null;
const originalExitCode = process.exitCode;

function createFixtureDaemon(readyDelayMs: number): {
  configFile: string;
  instance: Daemon;
  launchesFile: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), 'mearl-daemon-'));
  const configFile = join(tempDir, 'daemon.json');
  const logFile = join(tempDir, 'daemon.log');
  const launchesFile = join(tempDir, 'launches.txt');
  const scriptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'daemon-fixture.mjs',
  );
  const instance = createDaemon({
    name: 'TestDaemon',
    scriptPath,
    configFile,
    logFile,
    foregroundArgs: [configFile, launchesFile, String(readyDelayMs)],
    readyTimeoutMs: 2_000,
  });
  daemon = instance;
  return { configFile, instance, launchesFile };
}

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  process.exitCode = originalExitCode;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('daemon lifecycle', () => {
  it('spawns only one child when start is requested concurrently', async () => {
    const { instance, launchesFile } = createFixtureDaemon(250);

    await Promise.all([instance.start(), instance.start()]);

    expect(readFileSync(launchesFile, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(instance.running()?.pid).toBeGreaterThan(0);
  });

  it('does not stop an instance that no longer matches the requested pid', async () => {
    const { instance } = createFixtureDaemon(0);
    await instance.start();
    const runningPid = instance.running()!.pid;

    await instance.stop(runningPid + 1);

    expect(instance.running()?.pid).toBe(runningPid);
  });

  it('recovers an invalid startup lock left by an interrupted process', async () => {
    const { configFile, instance } = createFixtureDaemon(0);
    writeFileSync(`${configFile}.start.lock`, '{invalid');

    await instance.start();

    expect(instance.running()?.pid).toBeGreaterThan(0);
  });
});
