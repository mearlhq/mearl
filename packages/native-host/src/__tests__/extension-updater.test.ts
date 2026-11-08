import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateSetupManagedExtension } from '../extension-updater.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-extension-updater-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('setup-managed extension updater', () => {
  it('updates a newer configured release under a process lock', async () => {
    const directory = temporaryDirectory();
    const updateFiles = vi.fn(async () => ({
      archiveUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
      path: directory,
      version: '2.8.1',
    }));

    await expect(
      updateSetupManagedExtension(
        { currentVersion: '2.8.0', setupManagedPath: directory },
        {
          fetchRelease: async () => ({
            archiveUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
            version: '2.8.1',
          }),
          lockPath: path.join(directory, 'update.lock'),
          updateFiles,
        },
      ),
    ).resolves.toEqual({
      changelogUrl: 'https://github.com/mearlhq/mearl/releases/tag/v2.8.1',
      updated: true,
      version: '2.8.1',
    });
    expect(updateFiles).toHaveBeenCalledWith({
      release: {
        archiveUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
        version: '2.8.1',
      },
      targetDirectory: directory,
    });
    expect(fs.existsSync(path.join(directory, 'update.lock'))).toBe(false);
  });

  it('does not write files when the current version is already up to date', async () => {
    const updateFiles = vi.fn();
    await expect(
      updateSetupManagedExtension(
        { currentVersion: '2.8.1', setupManagedPath: temporaryDirectory() },
        {
          fetchRelease: async () => ({
            archiveUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
            version: '2.8.1',
          }),
          updateFiles,
        },
      ),
    ).resolves.toMatchObject({ updated: false, version: '2.8.1' });
    expect(updateFiles).not.toHaveBeenCalled();
  });

  it('rejects relative paths and a live concurrent update lock', async () => {
    await expect(
      updateSetupManagedExtension(
        { currentVersion: '2.8.0', setupManagedPath: 'relative/path' },
        { fetchRelease: vi.fn() },
      ),
    ).rejects.toThrow('setup-managed extension path');

    const directory = temporaryDirectory();
    const lockPath = path.join(directory, 'update.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ id: 'existing', pid: process.pid, startedAt: Date.now() }),
    );
    await expect(
      updateSetupManagedExtension(
        { currentVersion: '2.8.0', setupManagedPath: directory },
        {
          fetchRelease: async () => ({
            archiveUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
            version: '2.8.1',
          }),
          lockPath,
          updateFiles: vi.fn(),
        },
      ),
    ).rejects.toThrow('already running');
  });

  it('recovers a stale malformed update lock', async () => {
    const directory = temporaryDirectory();
    const lockPath = path.join(directory, 'update.lock');
    fs.writeFileSync(lockPath, '{');
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    await expect(
      updateSetupManagedExtension(
        { currentVersion: '2.8.0', setupManagedPath: directory },
        {
          fetchRelease: async () => ({
            archiveUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
            version: '2.8.1',
          }),
          lockPath,
          updateFiles: vi.fn(async () => ({
            archiveUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
            path: directory,
            version: '2.8.1',
          })),
        },
      ),
    ).resolves.toMatchObject({ updated: true });
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
