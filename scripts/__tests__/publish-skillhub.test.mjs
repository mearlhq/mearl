import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { skillHubMetadata, stageLicenses, submitSkill } from '../publish-skillhub.mjs';

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

it('stages license texts with extensions that SkillHub accepts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillhub-test-'));
  try {
    const skill = join(root, 'skill');
    const assets = join(skill, 'assets');
    const license = join(root, 'LICENSE');
    const bundled = join(assets, 'lucide.LICENSE');
    await mkdir(assets, { recursive: true });
    await writeFile(license, 'Apache license');
    await writeFile(bundled, 'Third-party license');
    await stageLicenses(skill, license);
    await expect(readFile(license, 'utf8')).resolves.toBe('Apache license');
    await expect(readFile(join(skill, 'LICENSE.txt'), 'utf8')).resolves.toBe('Apache license');
    await expect(readFile(`${bundled}.txt`, 'utf8')).resolves.toBe('Third-party license');
    await expect(readFile(bundled)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
