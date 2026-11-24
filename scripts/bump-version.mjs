import { readdir, readFile, writeFile, access } from 'node:fs/promises';
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

export async function bumpVersion(version, directory = root) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.test(version)) {
    throw new Error('Use an explicit release version, for example 3.0.0-beta.0');
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
  for (const [path, content] of updates) await writeFile(path, content);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals } = parseArgs({ allowPositionals: true });
  await bumpVersion(positionals[0] ?? '');
}
