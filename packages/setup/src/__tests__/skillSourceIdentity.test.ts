import { describe, expect, it } from 'vitest';
import { matchesTrackedSkillSource, type TrackedSkillSource } from '../skillSources.js';

const tracked = (source: string, patch: Partial<TrackedSkillSource> = {}): TrackedSkillSource => ({ name: 'sample', source, scope: 'global', hashKind: 'folder', ...patch });

describe('preset Skill source identity', () => {
  it.each([
    ['example/skills', 'https://github.com/example/skills.git', true],
    ['git@github.com:example/skills.git', 'https://github.com/example/skills', true],
    ['ssh://git@host.test:2222/team/repo.git', 'https://host.test/team/repo', false],
    ['ssh://git@github.com:2222/example/skills.git', 'https://github.com/example/skills', false],
    ['https://host.test/Team/repo', 'https://host.test/team/repo', false],
    ['https://github.com/example/skills#stable', 'https://github.com/example/skills#stable', true],
    ['https://github.com/example/skills#stable', 'https://github.com/example/skills#next', false],
    ['/tmp/local-skill', 'file:///tmp/local-skill', true],
    ['example/skills', 'example/other', false],
  ])('compares %s with %s', (requested, actual, result) => {
    expect(matchesTrackedSkillSource(requested, tracked(actual))).toBe(result);
  });

  it('retains explicit lock refs and verifies a requested source subtree', () => {
    expect(matchesTrackedSkillSource('example/skills#stable', tracked('https://github.com/example/skills.git', { ref: 'stable' }))).toBe(true);
    expect(matchesTrackedSkillSource('example/skills', tracked('example/skills', { ref: 'stable' }))).toBe(false);
    const source = 'https://github.com/example/skills/tree/main/skills';
    expect(matchesTrackedSkillSource(source, tracked('example/skills', { ref: 'main', skillPath: 'skills/sample/SKILL.md' }))).toBe(true);
    expect(matchesTrackedSkillSource(source, tracked('example/skills', { ref: 'main', skillPath: 'other/sample/SKILL.md' }))).toBe(false);
  });

  it('lets the selected manager normalize ambiguous shorthand using lock metadata', () => {
    const normalize = (source: string, sourceType?: string) => source === 'example/skills' ? `https://${sourceType === 'github' ? 'github.com' : 'internal.test'}/example/skills` : source;
    expect(matchesTrackedSkillSource('example/skills', tracked('https://internal.test/example/skills', { sourceType: 'internal' }), normalize)).toBe(true);
    expect(matchesTrackedSkillSource('example/skills', tracked('example/skills', { sourceType: 'github' }), normalize)).toBe(false);
    expect(matchesTrackedSkillSource('https://github.com/example/skills', tracked('example/skills', { sourceType: 'github' }), normalize)).toBe(true);
  });
});
