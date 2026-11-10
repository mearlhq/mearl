import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { packRelease, patchReleaseNotes, pendingPackages, prepareRelease, releaseVersion, selectRelease, verifyLatestPatch, verifyRelease, verifySelection, verifyTag } from '../ci-release.mjs';

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
  await writeFile(resolve(source, 'LICENSE'), 'Fixture license\n');
  await writeFile(resolve(source, 'packages/cloud/.gitkeep'), '');
  git(source, 'init', '-b', 'codex/open-source-ready');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'mearlhq/mearl', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'codex/open-source-ready', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: git(source, 'rev-parse', 'HEAD') };
  return { source, workspace: resolve(directory, 'build'), output: resolve(directory, 'artifacts'), env };
}

it.each([
  ['beta', '3.0.0-beta.2', '3.0.0.2', 'codex/open-source-ready'],
  ['patch', '3.0.1', '3.0.1.65535', 'main'],
])('exports a clean commit, injects %s metadata without notes and packs verifiable artifacts', async (channel, version, chromeVersion, branch) => {
  const { source, workspace, output, env } = await fixture();
  env.GITHUB_REF_NAME = branch;
  const sourcePackage = await readFile(resolve(source, 'package.json'), 'utf8');
  await prepareRelease(source, workspace, version, channel, env);
  expect(await readFile(resolve(source, 'package.json'), 'utf8')).toBe(sourcePackage);
  expect(git(source, 'status', '--porcelain')).toBe('');
  expect(await readdir(workspace)).not.toContain('changelogs');
  expect(JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8')).version).toBe(version);
  const extension = resolve(workspace, 'packages/extension/dist_chrome');
  await mkdir(extension);
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: chromeVersion, version_name: version }));
  const release = await packRelease(workspace, output, channel, env);
  expect(release.packages.map(value => value.name).sort()).toEqual(['@mearl/client', '@mearl/mcp-server']);
  expect(release.assets.map(value => value.file)).toContain(`mearl-chrome-v${version}.zip`);
  const checked = await verifyRelease(source, output, channel, env);
  expect(checked.args).toContain(`--publish-branch=${branch}`);
  expect(checked.args).toContain(channel === 'patch' ? 'latest' : 'beta');
  expect(checked.args).not.toContain('--no-git-checks');
  expect(checked.release.sourceCommit).toBe(env.GITHUB_SHA);
  const file = resolve(output, release.packages[0].file);
  await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('tampered')]));
  await expect(verifyRelease(source, output, channel, env)).rejects.toThrow('integrity mismatch');
});

it('rejects dirty sources, nested build directories, wrong workflow identity and uncommitted stable versions', async () => {
  const { source, workspace, env } = await fixture();
  await expect(prepareRelease(source, resolve(source, '..nested'), '3.0.0-beta.2', 'beta', env)).rejects.toThrow('outside');
  await expect(prepareRelease(source, workspace, '3.0.0-beta.2', 'beta', { ...env, GITHUB_REPOSITORY: 'someone/mearl' })).rejects.toThrow('approved repository');
  await expect(prepareRelease(source, workspace, '3.0.0', 'stable', { ...env, GITHUB_REF_NAME: 'main' })).rejects.toThrow('committed versions');
  await expect(prepareRelease(source, workspace, '3.1.1', 'patch', { ...env, GITHUB_REF_NAME: 'main' })).rejects.toThrow('same version line');
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

it('stops a patch retry before writes when any package has a newer latest version', async () => {
  const packages = [{ name: '@mearl/client' }, { name: '@mearl/setup' }];
  const current = async url => String(url).includes('client') ? Response.json({ version: '3.0.1' }) : new Response(null, { status: 404 });
  await expect(verifyLatestPatch(packages, '3.0.1', current)).resolves.toBeUndefined();
  await expect(verifyLatestPatch(packages, '3.0.1', async url => String(url).includes('setup') ? Response.json({ version: '3.0.2' }) : current(url))).rejects.toThrow('newer stable version (3.0.2)');
});

it('lists direct commits since the published release while skipping a reserved tag', async () => {
  const { source } = await fixture();
  const commit = message => git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', message);
  git(source, 'tag', 'v3.0.0');
  commit('fix: first patch change');
  git(source, 'tag', 'v3.0.1');
  commit('fix: second patch change');
  const notes = patchReleaseNotes(source, '3.0.2', tag => tag === 'v3.0.0');
  expect(notes).toContain('first patch change');
  expect(notes).toContain('second patch change');
  expect(notes).toContain('compare/v3.0.0...v3.0.2');
  expect(notes).not.toContain('compare/v3.0.1');
});

it.each([
  ['3.0.0-beta.1', 'beta', ['3.0.0-beta.1'], '3.0.0-beta.2'],
  ['3.0.0-beta.1', 'beta', ['3.0.0-beta.4'], '3.0.0-beta.5'],
  ['3.0.0', 'beta', ['3.0.0', '3.0.1'], '3.0.2-beta.0'],
  ['3.1.0-beta.0', 'beta', ['3.0.0'], '3.1.0-beta.0'],
  ['3.0.0', 'stable', ['3.0.0-beta.9'], '3.0.0'],
  ['3.0.0', 'patch', ['3.0.0', '3.0.1-beta.9'], '3.0.1'],
  ['3.0.1-beta.1', 'patch', ['3.0.0'], '3.0.1'],
  ['3.0.0', 'patch', ['3.0.9', '3.0.10', '3.1.0-beta.1'], '3.0.11'],
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
  expect(() => releaseVersion('3.0.0', 'unknown')).toThrow('Choose beta, stable or patch');
});

it('requires patch publishing to follow the latest stable version line', () => {
  expect(() => releaseVersion('3.0.0', 'patch', ['3.0.0-beta.1'])).toThrow('latest published stable version line');
  expect(() => releaseVersion('3.1.0', 'patch', ['3.0.0'])).toThrow('latest published stable version line');
  expect(() => releaseVersion('3.0.0', 'patch', ['3.0.1', '3.1.0'])).toThrow('latest published stable version line');
  expect(() => releaseVersion('3.0.2', 'patch', ['3.0.0'])).toThrow('latest published stable version line');
});

it('selects a patch above both reserved tags and npm versions and retains it on retry', async () => {
  const { source, workspace, env } = await fixture();
  git(source, 'tag', 'v3.0.5');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => Response.json({
    versions: String(url).includes('client') ? { '3.0.0': {} } : { '3.0.3': {}, '3.0.4-beta.1': {} },
  }));
  const context = { ...env, GITHUB_REF_NAME: 'main', GITHUB_RUN_ID: '123' };
  const selection = resolve(workspace, 'version.json');
  try {
    await expect(selectRelease(source, selection, 'patch', context)).resolves.toEqual({ version: '3.0.6', cached: false });
    git(source, 'tag', 'v3.0.8');
    fetch.mockClear();
    await expect(selectRelease(source, selection, 'patch', { ...context, GITHUB_RUN_ATTEMPT: '2' })).resolves.toEqual({ version: '3.0.6', cached: true });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it('restores a cached version before querying published packages and stops reruns without a record', async () => {
  const { source, workspace, env } = await fixture();
  const selection = resolve(workspace, 'version.json');
  const rerun = { ...env, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
  await expect(selectRelease(source, selection, 'beta', rerun)).rejects.toThrow('original release version record is missing');
  await writeFile(selection, JSON.stringify({ version: '3.0.0-beta.2', channel: 'beta', sourceCommit: env.GITHUB_SHA, runId: '123' }));
  await expect(selectRelease(source, selection, 'beta', rerun)).resolves.toEqual({ version: '3.0.0-beta.2', cached: true });
});
