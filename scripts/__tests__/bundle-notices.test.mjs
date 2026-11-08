import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { writeBundleNotices } from '../bundle-notices.mjs';

it('ships complete notices once per bundled dependency and excludes tree-shaken inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mearl-notices-'));
  try {
    for (const [name, code] of [['included', 'export const value = 42;'], ['omitted', 'export const unused = 0;']]) {
      const location = join(directory, 'node_modules', name); await mkdir(location, { recursive: true });
      await writeFile(join(location, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js', sideEffects: false }));
      await writeFile(join(location, 'index.js'), code);
      if (name === 'included') { await writeFile(join(location, 'LICENSE'), 'Copyright Fixture\nPermission text.\n'); await writeFile(join(location, 'NOTICE.txt'), 'Additional notice.'); }
    }
    await writeFile(join(directory, 'entry.js'), 'import {value} from "included"; import {unused} from "omitted"; console.log(value);');
    const result = await build({ absWorkingDir: directory, entryPoints: ['entry.js'], outfile: join(directory, 'out.js'), bundle: true, format: 'esm', metafile: true, write: false });
    const target = join(directory, 'notices.txt');
    expect(writeBundleNotices([result.metafile, result.metafile], directory, target)).toEqual(['included@1.0.0']);
    const text = await readFile(target, 'utf8');
    expect(text.match(/included@1.0.0/g)).toHaveLength(1);
    expect(text).toContain('Copyright Fixture\nPermission text.'); expect(text).toContain('Additional notice.'); expect(text).not.toContain('omitted');
    await rm(join(directory, 'node_modules/included/LICENSE')); await rm(join(directory, 'node_modules/included/NOTICE.txt'));
    expect(() => writeBundleNotices([result.metafile], directory, target)).toThrow('included@1.0.0');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
