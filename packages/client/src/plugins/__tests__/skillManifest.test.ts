import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  DISABLED_SKILL_MANIFEST,
  getSkillEnabled,
  setSkillEnabled,
  skillManifestPath,
} from '../skillManifest.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-skill-manifest-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('disables and restores the same manifest through a shared installation link', () => {
  const source = join(directory, 'source');
  const installed = join(directory, 'installed');
  mkdirSync(source);
  symlinkSync(source, installed, 'dir');
  writeFileSync(join(source, 'SKILL.md'), '---\nversion: "1.2.3"\n---\n# Skill');
  expect(getSkillEnabled(installed)).toBe(true);
  setSkillEnabled(installed, false);
  setSkillEnabled(installed, false);
  expect(getSkillEnabled(source)).toBe(false);
  expect(skillManifestPath(installed)).toBe(join(installed, DISABLED_SKILL_MANIFEST));
  setSkillEnabled(source, true);
  setSkillEnabled(source, true);
  expect(getSkillEnabled(installed)).toBe(true);
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toContain('# Skill');
});

it('rejects missing or conflicting manifests without overwriting either file', () => {
  expect(getSkillEnabled(directory)).toBeUndefined();
  expect(() => setSkillEnabled(directory, false)).toThrow('找不到');
  writeFileSync(join(directory, 'SKILL.md'), 'active');
  writeFileSync(join(directory, DISABLED_SKILL_MANIFEST), 'disabled');
  expect(() => setSkillEnabled(directory, false)).toThrow('冲突');
  expect(() => setSkillEnabled(directory, true)).toThrow('冲突');
  expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toBe('active');
  expect(readFileSync(join(directory, DISABLED_SKILL_MANIFEST), 'utf8')).toBe('disabled');
});

it('rejects directories and manifest symlinks', () => {
  mkdirSync(join(directory, 'SKILL.md'));
  expect(() => setSkillEnabled(directory, false)).toThrow('普通文件');
  rmSync(join(directory, 'SKILL.md'), { recursive: true });
  writeFileSync(join(directory, 'external'), 'external');
  symlinkSync(join(directory, 'external'), join(directory, 'SKILL.md'));
  expect(() => setSkillEnabled(directory, false)).toThrow('普通文件');
});

it('does not overwrite a dangling backup link', () => {
  writeFileSync(join(directory, 'SKILL.md'), 'active');
  symlinkSync(join(directory, 'missing'), join(directory, DISABLED_SKILL_MANIFEST));
  expect(() => setSkillEnabled(directory, false)).toThrow('冲突');
  expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toBe('active');
});
