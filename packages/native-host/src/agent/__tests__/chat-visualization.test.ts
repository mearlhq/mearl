import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readChatVisualization } from '../chat-visualization.js';

vi.mock('@mearl/daemon-core', () => ({
  get DAEMON_HOME() {
    return path.join(os.homedir(), '.mearl');
  },
}));

describe('readChatVisualization', () => {
  let directory: string;
  let output: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'mearl-visualization-'));
    output = path.join(directory, '.mearl', 'visualizations');
    await mkdir(output, { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads a UTF-8 HTML fragment inside the output directory', async () => {
    const file = path.join(output, 'chart.html');
    const html = '<svg><title>散点图</title></svg>';
    await writeFile(file, html);
    await expect(readChatVisualization(file, [output])).resolves.toEqual({ html });
  });

  it('reads from the Mearl visualization directory and rejects general output directories', async () => {
    const home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
    try {
      const chart = path.join(output, 'chart.html');
      const html = '<svg><title>Chart</title></svg>';
      await writeFile(chart, html);

      await expect(readChatVisualization(chart)).resolves.toEqual({ html });
      for (const otherOutput of [path.join(directory, 'output'), path.join(directory, 'work', 'output')]) {
        await expect(readChatVisualization(path.join(otherOutput, 'chart.html'))).rejects.toThrow('outside');
      }
    } finally {
      home.mockRestore();
    }
  });

  it('rejects other file types and paths escaping the output directory', async () => {
    const privateFile = path.join(directory, 'private.html');
    await writeFile(privateFile, 'private');
    await symlink(privateFile, path.join(output, 'linked.html'));

    await expect(readChatVisualization(path.join(output, 'chart.json'), [output])).rejects.toThrow('HTML path');
    await expect(readChatVisualization(path.join(output, '..', 'private.html'), [output])).rejects.toThrow('outside');
    await expect(readChatVisualization(path.join(output, 'linked.html'), [output])).rejects.toThrow('outside');
  });

  it('bounds the JSON response including string escaping', async () => {
    const file = path.join(output, 'chart.html');
    await writeFile(file, '"'.repeat(600 * 1024));
    await expect(readChatVisualization(file, [output])).rejects.toThrow('too large');
  });

  it('rejects an output directory that is itself a symbolic link', async () => {
    const alias = path.join(directory, 'alias');
    await symlink(output, alias, 'junction');
    await writeFile(path.join(output, 'chart.html'), '<svg></svg>');

    await expect(readChatVisualization(path.join(alias, 'chart.html'), [alias])).rejects.toThrow('outside');
  });
});
