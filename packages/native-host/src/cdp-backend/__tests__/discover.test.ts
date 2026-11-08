import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDevToolsActivePort } from '../discover.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readDevToolsActivePort', () => {
  it('reads the port from the requested managed profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mearl-discover-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'DevToolsActivePort'), '54321\n/devtools/browser/test\n');

    expect(readDevToolsActivePort(dir)).toEqual({
      port: 54321,
      browserWsPath: '/devtools/browser/test',
    });
  });

  it('returns null for a profile without an active port file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mearl-discover-'));
    dirs.push(dir);
    expect(readDevToolsActivePort(dir)).toBeNull();
  });
});
