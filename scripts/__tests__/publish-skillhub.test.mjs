import { expect, it, vi } from 'vitest';
import { skillHubMetadata, submitSkill } from '../publish-skillhub.mjs';

it('uses the release tag version while preserving the Skill body and Mearl metadata', () => {
  const skill = '---\nname: design-overlay\nversion: "3.1.0"\ndescription: Example\nmetadata:\n  mearl: true\n---\n# 设计稿对比\n\nversion: body\n';
  const result = skillHubMetadata(skill, 'design-overlay', '3.1.1');
  expect(result.slug).toBe('mearl-design-overlay');
  expect(result.markdown).toContain('version: "3.1.1"\n');
  expect(result.markdown).toContain('metadata:\n  mearl: true\n');
  expect(result.markdown).toContain('displayName: "Mearl 设计稿对比"\n');
  expect(result.markdown).toMatch(/---\n# 设计稿对比\n\nversion: body\n$/);
});

it('skips a conflict only when the publishing account already submitted that version', async () => {
  const publish = () => ({ status: 409, error: 'Slug conflict' });
  await expect(submitSkill(publish, () => true)).resolves.toEqual({ status: 'already submitted' });
  await expect(submitSkill(publish, () => false)).rejects.toThrow('Slug conflict');
});

it('retries rate limits using the advertised delay, with a bounded number of attempts', async () => {
  const delay = vi.fn();
  const limited = { status: 429, body: { retryAfter: 3 }, error: 'Rate limited' };
  const accepted = { skillId: 10, status: 'pending_review' };
  const publish = vi.fn().mockReturnValueOnce(limited).mockReturnValueOnce(accepted);
  await expect(submitSkill(publish, null, delay)).resolves.toBe(accepted);
  expect(delay).toHaveBeenCalledExactlyOnceWith(3000);

  const alwaysLimited = vi.fn().mockReturnValue(limited);
  await expect(submitSkill(alwaysLimited, null, delay)).rejects.toThrow('Rate limited');
  expect(alwaysLimited).toHaveBeenCalledTimes(3);
});
