import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { packRelease, pendingPackages, prepareRelease, releaseVersion, selectRelease, verifyRelease, verifySelection, verifyTag } from '../ci-release.mjs';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'mearl-ci-release-'));
  temporary.push(directory);
  const source = resolve(directory, 'source');
  for (const folder of ['packages/client', 'packages/mcp-server', 'packages/extension', 'packages/cloud', 'packages/website/public', 'skills/example']) await mkdir(resolve(source, folder), { recursive: true });
  const version = '3.0.0-beta.1';
  const repository = { type: 'git', url: 'git+https://github.com/mearlhq/mearl.git' };
  await writeFile(resolve(source, 'package.json'), JSON.stringify({ name: 'release-fixture', private: true, version }));
  for (const name of ['client', 'mcp-server']) {
    await writeFile(resolve(source, `packages/${name}/package.json`), JSON.stringify({ name: `@mearl/${name}`, version, repository, files: ['index.js'] }));
    await writeFile(resolve(source, `packages/${name}/index.js`), 'export const value = true;\n');
  }
  await writeFile(resolve(source, 'packages/extension/package.json'), JSON.stringify({ name: 'extension', private: true, version }));
  await writeFile(resolve(source, 'packages/mcp-server/server.json'), JSON.stringify({ version, packages: [{ version }] }));
  await writeFile(resolve(source, 'skills/example/SKILL.md'), `---\nname: example\nversion: "${version}"\n---\n`);
  await writeFile(resolve(source, 'packages/website/public/toolbox.json'), '{"tools":[]}\n');
  await writeFile(resolve(source, 'LICENSE'), 'Fixture license\n');
  await writeFile(resolve(source, 'packages/cloud/.gitkeep'), '');
  git(source, 'init', '-b', 'codex/open-source-ready');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'mearlhq/mearl', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'codex/open-source-ready', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: git(source, 'rev-parse', 'HEAD') };
  return { source, workspace: resolve(directory, 'build'), output: resolve(directory, 'artifacts'), env };
}

it('exports a clean commit, injects beta metadata without notes and packs verifiable artifacts', async () => {
  const { source, workspace, output, env } = await fixture();
  const sourcePackage = await readFile(resolve(source, 'package.json'), 'utf8');
  await prepareRelease(source, workspace, '3.0.0-beta.2', 'beta', env);
  expect(await readFile(resolve(source, 'package.json'), 'utf8')).toBe(sourcePackage);
  expect(git(source, 'status', '--porcelain')).toBe('');
  expect(await readdir(workspace)).not.toContain('changelogs');
  expect(JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8')).version).toBe('3.0.0-beta.2');
  const extension = resolve(workspace, 'packages/extension/dist_chrome');
  await mkdir(extension);
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '3.0.0.2', version_name: '3.0.0-beta.2' }));
  const release = await packRelease(workspace, output, 'beta', env);
  expect(release.packages.map(value => value.name).sort()).toEqual(['@mearl/client', '@mearl/mcp-server']);
  expect(release.assets.map(value => value.file)).toContain('mearl-chrome-v3.0.0-beta.2.zip');
  const checked = await verifyRelease(source, output, 'beta', env);
  expect(checked.args).toContain('--publish-branch=codex/open-source-ready');
  expect(checked.args).not.toContain('--no-git-checks');
  expect(checked.release.sourceCommit).toBe(env.GITHUB_SHA);
  const file = resolve(output, release.packages[0].file);
  await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('tampered')]));
  await expect(verifyRelease(source, output, 'beta', env)).rejects.toThrow('integrity mismatch');
});

it('rejects dirty sources, nested build directories, wrong workflow identity and uncommitted stable versions', async () => {
  const { source, workspace, env } = await fixture();
  await expect(prepareRelease(source, resolve(source, '..nested'), '3.0.0-beta.2', 'beta', env)).rejects.toThrow('outside');
  await expect(prepareRelease(source, workspace, '3.0.0-beta.2', 'beta', { ...env, GITHUB_REPOSITORY: 'someone/mearl' })).rejects.toThrow('approved repository');
  await expect(prepareRelease(source, workspace, '3.0.0', 'stable', { ...env, GITHUB_REF_NAME: 'main' })).rejects.toThrow('committed versions');
  await writeFile(resolve(source, 'pending.txt'), 'pending');
  await expect(prepareRelease(source, workspace, '3.0.0-beta.2', 'beta', env)).rejects.toThrow('clean source');
});

it('resumes only identical registry tarballs and fails before publishing conflicting versions', async () => {
  const items = [{ name: '@mearl/client', integrity: 'sha512-one' }, { name: '@mearl/setup', integrity: 'sha512-two' }];
  const pending = await pendingPackages(items, '3.0.0-beta.2', async url => String(url).includes('client') ? new Response(JSON.stringify({ dist: { integrity: 'sha512-one' } })) : new Response('', { status: 404 }));
  expect(pending).toEqual([items[1]]);
  await expect(pendingPackages(items, '3.0.0-beta.2', async () => new Response(JSON.stringify({ dist: { integrity: 'sha512-other' } })))).rejects.toThrow('Published artifact differs');
  await expect(pendingPackages(items, '3.0.0-beta.2', async () => new Response('', { status: 503 }))).rejects.toThrow('Registry verification failed');
  expect(() => verifyTag('old', 'current')).toThrow('another source commit');
  expect(() => verifyTag('current', 'current')).not.toThrow();
});

it.each([
  ['3.0.0-beta.1', 'beta', ['3.0.0-beta.1'], '3.0.0-beta.2'],
  ['3.0.0-beta.1', 'beta', ['3.0.0-beta.4'], '3.0.0-beta.5'],
  ['3.0.0', 'beta', ['3.0.0', '3.0.1'], '3.0.2-beta.0'],
  ['3.1.0-beta.0', 'beta', ['3.0.0'], '3.1.0-beta.0'],
  ['3.0.0', 'stable', ['3.0.0-beta.9'], '3.0.0'],
])('automatically selects the version for %s / %s', (source, channel, published, expected) => {
  expect(releaseVersion(source, channel, published)).toBe(expected);
});

it('retains one version per workflow run and rejects changed source or channel', () => {
  const record = { version: '3.0.0-beta.2', channel: 'beta', sourceCommit: 'commit', runId: '123' };
  const env = { GITHUB_SHA: 'commit', GITHUB_RUN_ID: '123' };
  expect(verifySelection(record, 'beta', env)).toBe('3.0.0-beta.2');
  expect(() => verifySelection(record, 'stable', env)).toThrow('another workflow');
  expect(() => verifySelection(record, 'beta', { ...env, GITHUB_SHA: 'other' })).toThrow('another workflow');
  expect(() => releaseVersion('3.0.0-beta.1', 'stable')).toThrow('committed stable version');
  expect(() => releaseVersion('3.0.0', 'unknown')).toThrow('Choose beta or stable');
});

it('restores a cached version before querying published packages and stops reruns without a record', async () => {
  const { source, workspace, env } = await fixture();
  const selection = resolve(workspace, 'version.json');
  const rerun = { ...env, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
  await expect(selectRelease(source, selection, 'beta', rerun)).rejects.toThrow('original release version record is missing');
  await writeFile(selection, JSON.stringify({ version: '3.0.0-beta.2', channel: 'beta', sourceCommit: env.GITHUB_SHA, runId: '123' }));
  await expect(selectRelease(source, selection, 'beta', rerun)).resolves.toEqual({ version: '3.0.0-beta.2', cached: true });
});
