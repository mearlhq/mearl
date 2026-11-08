import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { pickWorkspaceDirectory, resolveWorkspaceDirectory } from '../workspace-directory.js';

describe('workspace directory', () => {
  it('opens the macOS directory picker and canonicalizes the result', async () => {
    const run = vi.fn().mockResolvedValue(process.cwd());

    await expect(pickWorkspaceDirectory('darwin', run)).resolves.toBe(
      fs.realpathSync.native(process.cwd()),
    );
    expect(run).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('choose folder')]);
  });

  it('falls back to kdialog when zenity is unavailable', async () => {
    const missing = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const run = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce(process.cwd());

    await expect(pickWorkspaceDirectory('linux', run)).resolves.toBe(
      fs.realpathSync.native(process.cwd()),
    );
    expect(run.mock.calls.map(call => call[0])).toEqual(['zenity', 'kdialog']);
  });

  it('rejects relative, missing, and non-directory paths', () => {
    expect(() => resolveWorkspaceDirectory('relative/path')).toThrow('absolute path');
    expect(() => resolveWorkspaceDirectory('/path/that/does/not/exist')).toThrow('does not exist');
    expect(() => resolveWorkspaceDirectory(fileURLToPath(import.meta.url))).toThrow(
      'not a directory',
    );
  });
});
