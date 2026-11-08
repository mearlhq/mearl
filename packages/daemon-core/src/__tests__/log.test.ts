import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { pruneOrphanLogs } from '../log.js';

const directory = mkdtempSync(join(tmpdir(), 'mearl-orphan-log-'));
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('reclaims old orphan logs while retaining recent, registered and unknown files', () => {
  const old = new Date(Date.now() - 8 * 86400_000);
  const create = (name: string, aged = true) => {
    const file = join(directory, name);
    writeFileSync(file, 'diagnostics');
    if (aged) utimesSync(file, old, old);
    return file;
  };
  const orphan = create('aaaaaaaaaaaaaaaa.log');
  const backup = create('aaaaaaaaaaaaaaaa.log.1');
  const registered = create('bbbbbbbbbbbbbbbb.log');
  create('bbbbbbbbbbbbbbbb.json');
  const recent = create('cccccccccccccccc.log', false);
  const unknown = create('user.log');
  const linked = join(directory, 'dddddddddddddddd.log');
  symlinkSync(unknown, linked);
  mkdirSync(join(directory, 'eeeeeeeeeeeeeeee.log'));
  pruneOrphanLogs(directory);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(backup)).toBe(false);
  for (const file of [registered, recent, unknown, linked]) expect(existsSync(file)).toBe(true);
});
