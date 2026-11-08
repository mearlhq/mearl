import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimRecord,
  readRecord,
  removeInvalidRecord,
  removeRecordIfPid,
  writeRecord,
  writeRecordIfPid,
} from '../registry.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('daemon registry', () => {
  it('writes private records atomically', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mearl-registry-'));
    const file = join(tempDir, 'nested', 'record.json');
    const record = { pid: process.pid, token: 'sensitive' };

    writeRecord(file, record);

    expect(readRecord(file)).toEqual(record);
    if (process.platform !== 'win32') {
      expect(statSync(join(tempDir, 'nested')).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('claims a record once and only lets its owner remove it', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mearl-registry-'));
    const file = join(tempDir, 'record.json');

    expect(claimRecord(file, { pid: 101 })).toBe(true);
    expect(claimRecord(file, { pid: 202 })).toBe(false);
    expect(writeRecordIfPid(file, 202, { pid: 202 })).toBe(false);
    expect(writeRecordIfPid(file, 101, { pid: 101, state: 'connected' })).toBe(true);
    expect(removeRecordIfPid(file, 202)).toBe(false);
    expect(readRecord(file)).toEqual({ pid: 101, state: 'connected' });
    expect(removeRecordIfPid(file, 101)).toBe(true);
    expect(readRecord(file)).toBeNull();
  });

  it('recovers stale mutation locks and invalid records', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mearl-registry-'));
    const file = join(tempDir, 'record.json');
    const lockDir = `${file}.registry.lock`;
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, token: 'stale' }),
    );

    expect(claimRecord(file, { pid: 101 })).toBe(true);
    expect(readRecord(file)).toEqual({ pid: 101 });
    expect(removeRecordIfPid(file, 101)).toBe(true);

    writeFileSync(file, '{invalid');
    expect(removeInvalidRecord(file)).toBe(true);
    expect(removeInvalidRecord(file)).toBe(false);
  });
});
