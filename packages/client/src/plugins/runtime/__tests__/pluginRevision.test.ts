import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePluginRevision } from '../pluginRevision.js';
import { registerPlugin } from '../../pluginRegistry.js';

let directory: string;
let entry: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-revision-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  const skill = join(directory, 'skill');
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), '# Revision fixture');
  entry = join(skill, 'main.mjs');
  writeFileSync(
    entry,
    `export const unique = ${JSON.stringify(directory)}; export default app => app.command('echo', input => input);`,
  );
  registerPlugin('fixture', entry);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('source snapshots', () => {
  it('reuses identical source bytes and retains the original snapshot after edits', () => {
    const original = capturePluginRevision('fixture');
    const source = readFileSync(entry, 'utf8');
    expect(capturePluginRevision('fixture').revision).toBe(original.revision);
    writeFileSync(entry, "import 'not-packaged'; export default () => {};");
    const updated = capturePluginRevision('fixture');
    expect(updated.revision).not.toBe(original.revision);
    expect(readFileSync(original.entry, 'utf8')).toBe(source);
    expect(readFileSync(updated.entry, 'utf8')).toContain("import 'not-packaged'");
  });
});
