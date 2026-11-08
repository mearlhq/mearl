import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bumpVersion, workspaceManifests } from './bump-version.mjs';
import { publishArgs } from './publish.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'mearlhq/mearl';
const run = (command, args, cwd, input) => execFileSync(command, args, { cwd, input, maxBuffer: 64 * 1024 * 1024 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = (bytes, algorithm = 'sha512') => `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`;
const manifests = async directory => Promise.all((await workspaceManifests(directory)).map(async path => ({ path, value: await json(path) })));

function cleanSource(directory, commit) {
  if (run('git', ['rev-parse', 'HEAD'], directory).toString().trim() !== commit || run('git', ['status', '--porcelain'], directory).length) {
    throw new Error('Release requires the original clean source commit');
  }
}

const stableVersions = versions => versions
  .map(version => /^(\d+)\.(\d+)\.(\d+)$/.exec(version))
  .filter(Boolean)
  .map(([version, major, minor, patch]) => ({ version, major: Number(major), minor: Number(minor), patch: Number(patch) }))
  .sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);

function taggedVersions(directory, mergedOnly = false) {
  return run('git', ['tag', '--list', ...(mergedOnly ? ['--merged', 'HEAD'] : []), 'v*'], directory)
    .toString().trim().split('\n').map(tag => tag.slice(1));
}

export function releaseVersion(sourceVersion, channel, published = []) {
  const match = sourceVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!match) throw new Error('Source version must be a stable or beta version');
  if (channel === 'stable') {
    if (match[4] !== undefined) throw new Error('Prepare the committed stable version before publishing');
    return sourceVersion;
  }
  if (channel === 'patch') {
    const [major, minor, patch] = match.slice(1, 4).map(Number);
    const [latest] = stableVersions(published);
    if (!latest || latest.major !== major || latest.minor !== minor || latest.patch + 1 < patch) {
      throw new Error('Patch publishing requires the source to be on the latest published stable version line');
    }
    return [major, minor, latest.patch + 1].join('.');
  }
  if (channel !== 'beta') throw new Error('Choose beta, stable or patch publishing');
  let base = match.slice(1, 4).join('.');
  let patch = Number(match[3]);
  while (published.includes(base)) base = `${match[1]}.${match[2]}.${++patch}`;
  const prefix = `${base}-beta.`;
  const numbers = published.filter(version => version.startsWith(prefix)).map(version => version.slice(prefix.length)).filter(value => /^\d+$/.test(value)).map(Number);
  const next = Math.max(-1, ...numbers) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Beta version sequence is too large');
  return `${base}-beta.${next}`;
}

export function verifySelection(record, channel, env) {
  if (record.sourceCommit !== env.GITHUB_SHA || record.runId !== env.GITHUB_RUN_ID || record.channel !== channel) throw new Error('Cached version belongs to another workflow run or source');
  return record.version;
}

export async function selectRelease(directory, selection, channel, env = process.env) {
  cleanSource(directory, env.GITHUB_SHA);
  if (!env.GITHUB_RUN_ID) throw new Error('Version selection requires a workflow run');
  await mkdir(dirname(selection), { recursive: true });
  const record = await json(selection).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  const packages = await manifests(directory);
  let version;
  if (record) {
    version = verifySelection(record, channel, env);
  } else {
    if (Number(env.GITHUB_RUN_ATTEMPT ?? 1) > 1) throw new Error('The original release version record is missing; start a new workflow run after checking partial publication');
    const documents = channel === 'beta' || channel === 'patch' ? await Promise.all(packages.filter(({ value }) => !value.private).map(async ({ value }) => {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(value.name)}`, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) return {};
      if (!response.ok) throw new Error(`Registry verification failed: ${response.status}`);
      return response.json();
    })) : [];
    const published = documents.flatMap(document => Object.keys(document.versions ?? {}));
    if (channel === 'patch') published.push(...taggedVersions(directory));
    version = releaseVersion(packages[0].value.version, channel, published);
    await writeFile(selection, JSON.stringify({ version, channel, sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID }, null, 2) + '\n');
  }
  publishArgs(packages.map(({ value }) => ({ ...value, version })), { channel, env });
  return { version, cached: Boolean(record) };
}

export async function prepareRelease(directory, workspace, version, channel, env = process.env) {
  cleanSource(directory, env.GITHUB_SHA);
  const packages = await manifests(directory);
  publishArgs(packages.map(({ value }) => ({ ...value, version })), { channel, env });
  const offset = relative(directory, workspace);
  if (!offset || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep))) throw new Error('Release workspace must be outside the source checkout');
  if (channel === 'stable' && (packages.some(({ value }) => value.version !== version) || !(await readFile(resolve(directory, `changelogs/v${version}.md`), 'utf8')).trim())) {
    throw new Error('Stable releases require committed versions and release notes');
  }
  if (channel === 'patch') {
    const [target, source] = [version, packages[0].value.version.split('-')[0]].map(value => stableVersions([value])[0]);
    if (!source || target.major !== source.major || target.minor !== source.minor || target.patch < source.patch) {
      throw new Error('Patch build version must match or advance the source patch on the same version line');
    }
  }
  await mkdir(workspace);
  const archive = resolve(workspace, 'source.tar');
  await writeFile(archive, run('git', ['archive', 'HEAD'], directory));
  run('tar', ['-xf', archive, '-C', workspace], directory);
  // Generated versions belong to the exported build tree.
  if (channel === 'beta' || channel === 'patch') await bumpVersion(version, workspace, { changelog: false });
}

async function zipFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await zipFiles(directory, path));
    else if (entry.isFile()) {
      await utimes(resolve(directory, path), new Date('1985-01-01T00:00:00Z'), new Date('1985-01-01T00:00:00Z'));
      files.push(path);
    } else throw new Error('Extension archive must contain regular files');
  }
  return files.sort();
}

export async function packRelease(workspace, output, channel, env = process.env) {
  const packages = await manifests(workspace);
  const version = packages[0].value.version;
  publishArgs(packages.map(({ value }) => value), { channel, env });
  await mkdir(output);
  await mkdir(resolve(output, 'npm'));
  const packed = [];
  for (const { path, value } of packages.filter(({ value }) => !value.private)) {
    run('pnpm', ['pack', '--pack-destination', resolve(output, 'npm')], dirname(path));
    const file = `npm/${value.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
    packed.push({ name: value.name, file, integrity: hash(await readFile(resolve(output, file))) });
  }
  const extension = resolve(workspace, 'packages/extension/dist_chrome');
  const manifest = await json(resolve(extension, 'manifest.json'));
  if ((manifest.version_name || manifest.version) !== version) throw new Error('Extension version differs from npm packages');
  const extensionFile = `mearl-chrome-v${version}.zip`;
  execFileSync('zip', ['-Xq', resolve(output, extensionFile), ...await zipFiles(extension)], { cwd: extension, env: { ...process.env, TZ: 'UTC' } });
  await cp(resolve(workspace, 'LICENSE'), resolve(output, 'LICENSE'));
  await cp(resolve(workspace, 'packages/website/public/toolbox.json'), resolve(output, 'toolbox.json'));
  await writeFile(resolve(output, 'config.json'), JSON.stringify({ latestVersion: version, downloadUrl: `https://github.com/${repository}/releases/download/v${version}/${extensionFile}` }, null, 2) + '\n');
  const assets = [];
  for (const file of [extensionFile, 'config.json', 'toolbox.json', 'LICENSE']) assets.push({ file, integrity: hash(await readFile(resolve(output, file))) });
  const release = { version, channel, sourceCommit: env.GITHUB_SHA, packages: packed, assets };
  await writeFile(resolve(output, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}

export async function verifyRelease(directory, output, channel, env = process.env) {
  const release = await json(resolve(output, 'release.json'));
  cleanSource(directory, release.sourceCommit);
  if (env.GITHUB_ACTIONS === 'true' && release.sourceCommit !== env.GITHUB_SHA) throw new Error('Release source does not match this workflow');
  if (release.channel !== channel) throw new Error('Release channel differs from prepared artifacts');
  const packed = [];
  for (const item of [...release.packages, ...release.assets]) {
    if (item.file !== basename(item.file) && !(item.file.startsWith('npm/') && item.file.slice(4) === basename(item.file))) throw new Error('Invalid release artifact path');
    if (hash(await readFile(resolve(output, item.file))) !== item.integrity) throw new Error(`Artifact integrity mismatch: ${item.file}`);
  }
  for (const item of release.packages) {
    const manifest = JSON.parse(run('tar', ['-xOf', resolve(output, item.file), 'package/package.json'], directory).toString());
    if (manifest.name !== item.name || manifest.version !== release.version || manifest.private) throw new Error('Packed package metadata differs from release');
    packed.push(manifest);
  }
  const expected = (await manifests(directory)).filter(({ value }) => !value.private).map(({ value }) => value.name).sort();
  if (JSON.stringify(packed.map(value => value.name).sort()) !== JSON.stringify(expected)) throw new Error('Release package set differs from source');
  const args = publishArgs(packed, { channel, env });
  return { release, args };
}

export async function pendingPackages(packages, version, request = fetch) {
  const pending = [];
  for (const item of packages) {
    const response = await request(`https://registry.npmjs.org/${encodeURIComponent(item.name)}/${encodeURIComponent(version)}`);
    if (response.status === 404) pending.push(item);
    else if (!response.ok) throw new Error(`Registry verification failed: ${response.status}`);
    else if ((await response.json()).dist?.integrity !== item.integrity) throw new Error(`Published artifact differs: ${item.name}@${version}`);
  }
  return pending;
}

export async function verifyLatestPatch(packages, version, request = fetch) {
  const versions = await Promise.all(packages.map(async ({ name }) => {
    const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return '';
    if (!response.ok) throw new Error(`Registry verification failed: ${response.status}`);
    return (await response.json()).version;
  }));
  const [latest] = stableVersions([version, ...versions]);
  if (latest.version !== version) throw new Error(`A newer stable version (${latest.version}) supersedes patch ${version}`);
}

function github(path) {
  try { return JSON.parse(run('gh', ['api', path], root).toString()); }
  catch (error) { if (error.stderr?.toString().includes('(HTTP 404)')) return undefined; throw error; }
}

export function verifyTag(commit, expected) {
  if (commit !== expected) throw new Error('Existing release tag belongs to another source commit');
}

export function patchReleaseNotes(directory, version, isPublished) {
  const [target] = stableVersions([version]);
  const previous = stableVersions(taggedVersions(directory, true)).find(value =>
    value.major === target.major && value.minor === target.minor && value.patch < target.patch && isPublished(`v${value.version}`),
  );
  const tag = previous && `v${previous.version}`;
  const commits = run('git', [
    'log', '--no-merges', '--format=- %s (%h)', ...(tag ? [`refs/tags/${tag}..HEAD`] : ['--max-count=20']),
  ], directory).toString().trim();
  const notes = [
    '## 补丁发布 / Patch release',
    commits || '本次发布与上一正式版使用同一源码。 / This patch uses the same source as the previous stable release.',
  ];
  if (tag) notes.push(`[完整变更 / Full changelog](https://github.com/${repository}/compare/${tag}...v${version})`);
  return notes.join('\n\n') + '\n';
}

async function githubRelease(directory, output, channel, env) {
  const { release } = await verifyRelease(directory, output, channel, env);
  const tag = `v${release.version}`;
  const api = `repos/${repository}`;
  let ref = github(`${api}/git/ref/tags/${tag}`);
  if (ref) {
    let object = ref.object;
    while (object.type === 'tag') object = github(`${api}/git/tags/${object.sha}`).object;
    verifyTag(object.sha, release.sourceCommit);
  } else run('gh', ['api', '--method', 'POST', `${api}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${release.sourceCommit}`], directory);
  const existing = github(`${api}/releases/tags/${tag}`);
  if (!existing) {
    let notes;
    let input;
    if (channel === 'beta') notes = ['--notes', `Beta build from ${release.sourceCommit}.`];
    else if (channel === 'patch') {
      input = patchReleaseNotes(directory, release.version, previousTag => {
        const previous = github(`${api}/releases/tags/${previousTag}`);
        return previous && !previous.draft && !previous.prerelease;
      });
      notes = ['--notes-file', '-'];
    } else notes = ['--notes-file', resolve(directory, `changelogs/${tag}.md`)];
    run('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--title', tag, ...(channel === 'beta' ? ['--prerelease'] : []), ...notes, ...release.assets.map(item => resolve(output, item.file))], directory, input);
    return;
  }
  if (existing.draft || existing.prerelease !== (channel === 'beta')) throw new Error('Existing GitHub release has a different channel');
  for (const item of release.assets) {
    const asset = existing.assets.find(value => value.name === item.file);
    if (asset) {
      const bytes = run('gh', ['api', `${api}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], directory);
      if (hash(bytes) !== item.integrity) throw new Error(`Existing release attachment differs: ${item.file}`);
    } else run('gh', ['release', 'upload', tag, '--repo', repository, resolve(output, item.file)], directory);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ options: { channel: { type: 'string', default: 'beta' }, version: { type: 'string' }, workspace: { type: 'string' }, artifacts: { type: 'string' }, selection: { type: 'string' } }, allowPositionals: true });
  const [operation] = positionals;
  const output = values.artifacts && resolve(values.artifacts);
  if (operation === 'select') {
    const result = await selectRelease(root, resolve(values.selection), values.channel);
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `version=${result.version}\ncached=${result.cached}\n`, { flag: 'a' });
    console.log(JSON.stringify(result));
  } else if (operation === 'prepare') await prepareRelease(root, resolve(values.workspace), values.version, values.channel);
  else if (operation === 'pack') await packRelease(root, output, values.channel);
  else if (operation === 'check') console.log((await verifyRelease(root, output, values.channel)).release);
  else if (operation === 'publish') {
    const { release, args } = await verifyRelease(root, output, values.channel);
    if (values.channel === 'patch') await verifyLatestPatch(release.packages, release.version);
    // A tag is immutable once it identifies a different source tree.
    const ref = github(`repos/${repository}/git/ref/tags/v${release.version}`);
    if (ref) {
      let object = ref.object;
      while (object.type === 'tag') object = github(`repos/${repository}/git/tags/${object.sha}`).object;
      verifyTag(object.sha, release.sourceCommit);
    }
    const pending = await pendingPackages(release.packages, release.version);
    for (const item of pending) execFileSync('pnpm', ['publish', resolve(output, item.file), ...args], { cwd: root, stdio: 'inherit' });
  } else if (operation === 'github') await githubRelease(root, output, values.channel, process.env);
  else throw new Error('Choose select, prepare, pack, check, publish or github');
}
