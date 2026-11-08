import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_HOME, hashKey, keyedDir, keyedConfigFile, keyedLogFile } from '../paths';

describe('DAEMON_HOME', () => {
  it('roots under the user home directory', () => {
    expect(DAEMON_HOME).toBe(join(homedir(), '.mearl'));
  });
});

describe('hashKey', () => {
  it('is the first 16 hex chars of the sha256 of the key', () => {
    const expected = createHash('sha256')
      .update('http://localhost:8080')
      .digest('hex')
      .slice(0, 16);
    expect(hashKey('http://localhost:8080')).toBe(expected);
  });

  it('produces a 16-char lowercase hex string', () => {
    expect(hashKey('anything')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic and collision-distinct for different keys', () => {
    expect(hashKey('a')).toBe(hashKey('a'));
    expect(hashKey('a')).not.toBe(hashKey('b'));
  });
});

describe('keyed path helpers', () => {
  it('keyedDir joins the subdir under DAEMON_HOME', () => {
    expect(keyedDir('connectors')).toBe(join(DAEMON_HOME, 'connectors'));
  });

  it('keyedConfigFile derives <hash>.json inside the subdir', () => {
    const key = 'wss://cloud.example/agent';
    expect(keyedConfigFile('connectors', key)).toBe(
      join(DAEMON_HOME, 'connectors', `${hashKey(key)}.json`),
    );
  });

  it('keyedLogFile derives <hash>.log inside the subdir', () => {
    const key = 'wss://cloud.example/agent';
    expect(keyedLogFile('connectors', key)).toBe(
      join(DAEMON_HOME, 'connectors', `${hashKey(key)}.log`),
    );
  });

  it('config and log files for the same key share a basename', () => {
    const cfg = keyedConfigFile('connectors', 'k');
    const log = keyedLogFile('connectors', 'k');
    expect(cfg.replace(/\.json$/, '')).toBe(log.replace(/\.log$/, ''));
  });
});
