import { readdir, readFile, writeFile, mkdir, access, open, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function workspaceManifests(directory = root) {
  const files = [join(directory, 'package.json')];
  for (const group of ['packages', 'packages/cloud']) {
    for (const entry of await readdir(join(directory, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, group, entry.name, 'package.json');
      try { await access(path); files.push(path); } catch {}
    }
  }
  return files;
}

export async function bumpVersion(version, directory = root, { changelog = true } = {}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.test(version)) {
    throw new Error('Use an explicit release version, for example 3.0.0-beta.0');
  }
  const tag = `v${version}`;
  const notesUrl = `https://github.com/mearlhq/mearl/blob/${tag}/changelogs/${tag}`;
  const notesHeader = `[简体中文](${notesUrl}.md) | [English](${notesUrl}.en.md)\n\n`;
  const releaseNotes = changelog ? [
    [join(directory, 'changelogs', `${tag}.md`), notesHeader + '### 版本重点\n\n待补充本次版本重点。\n\n### 变更\n\n待补充具体变化及提交引用。\n'],
    [join(directory, 'changelogs', `${tag}.en.md`), notesHeader + '### Highlights\n\nAdd the highlights for this release.\n\n### Changes\n\nDescribe the changes and link to their commits.\n'],
  ] : [];
  for (const [changelogPath] of releaseNotes) {
    try {
      await access(changelogPath);
      throw new Error('Changelog already exists: ' + changelogPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const updates = new Map();
  for (const path of await workspaceManifests(directory)) {
    const value = JSON.parse(await readFile(path, 'utf8'));
    value.version = version;
    updates.set(path, JSON.stringify(value, null, 2) + '\n');
  }
  const catalog = [];
  async function skills(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) await skills(file);
      else if (entry.name === 'SKILL.md') {
        const content = await readFile(file, 'utf8');
        const next = content.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/, (all, open, fields, close) => {
          if (!/^version:/m.test(fields)) throw new Error('Skill has no top-level version: ' + file);
          return open + fields.replace(/^version:.*$/m, `version: "${version}"`) + close;
        });
        if (next === content && !content.includes(`version: "${version}"`)) throw new Error('Skill has no frontmatter: ' + file);
        updates.set(file, next);
        if (dirname(path) === join(directory, 'skills')) catalog.push(basename(path));
      }
    }
  }
  await skills(join(directory, 'skills'));
  updates.set(join(directory, 'skills/catalog.json'), JSON.stringify(catalog.sort(), null, 2) + '\n');
  const serverPath = join(directory, 'packages/mcp-server/server.json');
  const server = JSON.parse(await readFile(serverPath, 'utf8'));
  server.version = version;
  for (const entry of server.packages) entry.version = version;
  updates.set(serverPath, JSON.stringify(server, null, 2) + '\n');
  if (releaseNotes.length) {
    await mkdir(join(directory, 'changelogs'), { recursive: true });
    const created = [];
    try {
      for (const [path, content] of releaseNotes) {
        const file = await open(path, 'wx');
        created.push(path);
        try {
          await file.writeFile(content);
        } finally {
          await file.close();
        }
      }
    } catch (error) {
      const cleanup = await Promise.allSettled(created.map(path => unlink(path)));
      const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError([error, ...failures], 'Could not write or clean up release notes');
      throw error;
    }
  }
  for (const [path, content] of updates) await writeFile(path, content);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ options: { 'no-changelog': { type: 'boolean', default: false } }, allowPositionals: true });
  await bumpVersion(positionals[0] ?? '', root, { changelog: !values['no-changelog'] });
}
