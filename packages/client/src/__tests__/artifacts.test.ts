import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { exportArtifact, stageFile } from '../artifacts.js';

describe('browser file transfer', () => {
  it('stages caller-local binary files and pins all chunks to their originating browser', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mearl-client-artifact-'));
    try {
      const input = Buffer.alloc(600000, 173);
      const file = path.join(directory, 'report.bin');
      await writeFile(file, input);
      const chunks: Buffer[] = [];
      const invoke = vi.fn(async (action: string, data: any) => {
        if (action === '__artifact_init')
          return { artifact: { artifactId: 'file-1' }, browserId: 'mearl:remote:host:chrome' };
        if (action === '__artifact_write') chunks.push(Buffer.from(data.base64, 'base64'));
        return {};
      });
      await stageFile({ invoke }, file, {});
      expect(Buffer.concat(chunks).equals(input)).toBe(true);
      expect(
        invoke.mock.calls
          .filter(call => call[0] !== '__artifact_init')
          .every(call => (call as any)[2].browser === 'mearl:remote:host:chrome'),
      ).toBe(true);
      expect(invoke).toHaveBeenLastCalledWith(
        '__artifact_complete',
        { artifactId: 'file-1', bytes: input.length },
        { browser: 'mearl:remote:host:chrome' },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves an existing output file when export is truncated and removes partial files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mearl-client-export-'));
    try {
      const output = path.join(directory, 'report.txt');
      await writeFile(output, 'existing');
      const artifact = {
        artifactId: 'file',
        filename: 'report.txt',
        bytes: 2,
        location: 'browser' as const,
        browserId: 'mearl:local:chrome',
      };
      const invoke = vi.fn(async () => ({ base64: '', bytes: 0, totalBytes: 2 }));
      await expect(exportArtifact({ invoke }, artifact, output)).rejects.toThrow('truncated');
      expect(await readFile(output, 'utf8')).toBe('existing');
      expect(await readdir(directory)).toEqual(['report.txt']);
      invoke.mockResolvedValue({ base64: 'aGk=', bytes: 2, totalBytes: 2 });
      await exportArtifact({ invoke }, artifact, output);
      expect(await readFile(output, 'utf8')).toBe('hi');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
