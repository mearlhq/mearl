import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uninstallNativeHost } from '../install.js';

const temporaryDirectories: string[] = [];

function createHostDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-native-host-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createArtifacts(directory: string, hostName: string): void {
  fs.writeFileSync(path.join(directory, `${hostName}.json`), '{}');
  fs.writeFileSync(path.join(directory, `${hostName}-launcher.sh`), '#!/bin/sh\n');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('uninstallNativeHost', () => {
  it('removes only the selected integration artifacts', async () => {
    const hostDir = createHostDirectory();
    createArtifacts(hostDir, 'ai.mearl.skills');
    createArtifacts(hostDir, 'ai.mearl.mcp');

    await expect(
      uninstallNativeHost({ mode: 'skills', silent: true }, { hostDir, platform: 'darwin' }),
    ).resolves.toBe(true);

    expect(fs.existsSync(path.join(hostDir, 'ai.mearl.skills.json'))).toBe(false);
    expect(fs.existsSync(path.join(hostDir, 'ai.mearl.skills-launcher.sh'))).toBe(false);
    expect(fs.existsSync(path.join(hostDir, 'ai.mearl.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(hostDir, 'ai.mearl.mcp-launcher.sh'))).toBe(true);
  });

  it('is idempotent when artifacts are already absent', async () => {
    const hostDir = createHostDirectory();

    await expect(
      uninstallNativeHost({ mode: 'both', silent: true }, { hostDir, platform: 'linux' }),
    ).resolves.toBe(true);
  });
});
