import { execFileSync, spawnSync } from 'node:child_process';
import { cp, glob, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const host = 'https://api.skillhub.cn';
const pendingOrApproved = new Set(['pending', 'pending_review', 'security_review', 'admin_review', 'platform_review', 'approved']);

export function skillHubMetadata(markdown, name, version) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  const title = match?.[2].match(/^# (.+?)\s*$/m)?.[1];
  if (!title || !/^name: .+$/m.test(match[1]) || !/^version: .+$/m.test(match[1])) {
    throw new Error(`Expected a name, version and title in ${name}/SKILL.md`);
  }
  const slug = /^mearl(?:-|$)/.test(name) ? name : `mearl-${name}`;
  const displayName = /^mearl\b/i.test(title) ? title : `Mearl ${title}`;
  const header = match[1]
    .replace(/^(slug|displayName|license|homepage):[^\n]*\n?/gm, '')
    .replace(/^version: .+$/m, `version: "${version}"`)
    .trimEnd();
  return {
    slug,
    markdown: `---\n${header}\nslug: ${slug}\ndisplayName: ${JSON.stringify(displayName)}\nlicense: Apache-2.0\nhomepage: https://github.com/mearlhq/mearl\n---\n${match[2]}`,
  };
}

export async function stageLicenses(directory, releaseLicense) {
  // SkillHub requires a file extension, including for license notices.
  for await (const file of glob(['**/LICENSE', '**/*.LICENSE'], { cwd: directory })) {
    const source = join(directory, file);
    await cp(source, `${source}.txt`, { force: false, errorOnExist: true });
    await rm(source);
  }
  await cp(releaseLicense, join(directory, 'LICENSE.txt'), { force: false });
}

async function versionInReview(slug, version, token) {
  // The dashboard includes this account's pending versions, which the public catalog omits.
  const response = await fetch(`${host}/api/v1/dashboard/skills/${slug}/versions`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Could not check SkillHub version history (HTTP ${response.status})`);
  const { versions } = await response.json();
  return versions.some(entry => entry.version === version && pendingOrApproved.has(entry.reviewStatus));
}

export async function submitSkill(publish, alreadySubmitted, delay = wait) {
  for (let attempt = 0; ; attempt++) {
    const { ok, result } = publish();
    // The CLI exits successfully for an accepted submission even when the
    // response has no top-level skillId or status.
    if (ok) {
      const details = result.data ?? result;
      return {
        status: typeof details.status === 'string' ? details.status : 'submitted',
        publicUrl: details.publicUrl,
      };
    }
    if (result.status === 409 && await alreadySubmitted()) return { status: 'already submitted' };
    if (result.status !== 429 || attempt >= 2) {
      throw new Error(result.error ?? 'Unexpected response from SkillHub');
    }
    const retryAfter = Number(result.body?.retryAfter);
    if (retryAfter > 60) throw new Error(result.error);
    await delay((retryAfter > 0 ? retryAfter : 60) * 1_000);
  }
}

function runCli(cli, directory, args, token = '') {
  const result = spawnSync(cli, ['publish', directory, '--host', host, '--json', ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLHUB_SKIP_SELF_UPGRADE: '1', SKILLHUB_TOKEN: token },
    timeout: 130_000,
  });
  if (result.error) throw result.error;
  if (result.stdout) {
    const parsed = JSON.parse(result.stdout);
    if (result.status === 0) return { ok: true, result: parsed };
    if (parsed.success === false) return { ok: false, result: parsed };
  }
  throw new Error(result.stderr?.trim() || `SkillHub CLI exited with ${result.status ?? result.signal}`);
}

async function main() {
  const { values } = parseArgs({ options: {
    tag: { type: 'string' }, cli: { type: 'string', default: 'skillhub' }, 'dry-run': { type: 'boolean' },
  } });
  const { tag, cli, 'dry-run': dryRun } = values;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Set --tag to a stable Mearl release tag such as v3.1.0');
  }
  const version = tag.slice(1);
  const token = dryRun ? '' : process.env.SKILLHUB_TOKEN?.trim();
  if (!dryRun && !token?.startsWith('skh_')) throw new Error('Set SKILLHUB_TOKEN to a personal SkillHub API Key');
  const staging = await mkdtemp(join(tmpdir(), 'mearl-skillhub-'));
  try {
    const archive = join(staging, 'source.tar');
    execFileSync('git', ['archive', '-o', archive, `refs/tags/${tag}`, 'skills', 'LICENSE']);
    execFileSync('tar', ['-xf', archive, '-C', staging]);
    const skillsRoot = join(staging, 'skills');
    const catalog = [];
    for await (const file of glob('*/SKILL.md', { cwd: skillsRoot, exclude: ['__tests__/**'] })) {
      catalog.push(file.split('/')[0]);
    }
    if (!catalog.length || !catalog.every(name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
      throw new Error('Invalid Skill directories in release tag');
    }

    const skills = [];
    for (const name of catalog.sort()) {
      const directory = join(skillsRoot, name);
      const file = join(directory, 'SKILL.md');
      const skill = skillHubMetadata(await readFile(file, 'utf8'), name, version);
      if (skills.some(({ slug }) => slug === skill.slug)) throw new Error(`Duplicate SkillHub slug: ${skill.slug}`);
      await writeFile(file, skill.markdown);
      await stageLicenses(directory, join(staging, 'LICENSE'));
      const { ok, result: preflight } = runCli(cli, directory, ['--dry-run']);
      if (!ok || !preflight.dryRun || preflight.slug !== skill.slug || preflight.version !== version) {
        throw new Error(`Unexpected SkillHub preflight result for ${skill.slug}`);
      }
      skills.push({ directory, slug: skill.slug });
      console.log(`${skill.slug}@${version}: preflight passed`);
    }
    if (dryRun) return;

    const changelog = `Mearl ${tag}: https://github.com/mearlhq/mearl/releases/tag/${tag}`;
    for (const { directory, slug } of skills) {
      try {
        const result = await submitSkill(
          () => runCli(cli, directory, ['--changelog', changelog], token),
          () => versionInReview(slug, version, token),
        );
        console.log(`${slug}@${version}: ${result.status}${result.publicUrl ? ` ${result.publicUrl}` : ''}`);
      } catch (error) {
        const message = error.message.replaceAll(token, '[redacted]');
        console.error(`${slug}@${version}: ${message}`);
        process.exitCode = 1;
        if (/权限不足|先执行.*login|HTTP (401|403)|发布频率过高/.test(message)) break;
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
