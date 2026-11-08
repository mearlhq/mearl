import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { comparePixels } from './compare.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fromExtension = createRequire(resolve(root, 'package.json'));
const assets = fileURLToPath(new URL('../assets/toolbox/', import.meta.url));
const lucideRoot = dirname(fromExtension.resolve('lucide-react/package.json'));
const icons = {};
for (const [name, filename] of Object.entries({
  refresh: 'refresh-cw', pick: 'crosshair', close: 'x', reset: 'rotate-ccw',
  document: 'clipboard-paste', file: 'folder-open', eye: 'eye', hidden: 'eye-off',
  lock: 'lock', unlock: 'lock-open',
})) {
  const icon = await readFile(resolve(lucideRoot, `dist/esm/icons/${filename}.js`), 'utf8');
  const literal = icon.match(/const __iconNode = (\[[\s\S]*?\]);/)[1];
  icons[name] = runInNewContext(`(${literal})`).map(([tag, attributes]) => {
    delete attributes.key;
    return [tag, attributes];
  });
}
const iconScript = '// Lucide icon nodes; see lucide.LICENSE.\nwindow.designOverlayIcons = ' + JSON.stringify(icons) + ';\n';
const compareScript = '// Generated from scripts/compare.mjs.\nwindow.designOverlayCompare = ' + comparePixels.toString() + ';\n';
if (process.argv.includes('--check')) {
  if (await readFile(resolve(assets, 'icons.js'), 'utf8') !== iconScript) throw new Error('Design Overlay icons are outdated');
  if (await readFile(resolve(assets, 'compare.js'), 'utf8') !== compareScript) throw new Error('Design Overlay comparator is outdated');
} else {
  await writeFile(resolve(assets, 'icons.js'), iconScript);
  await writeFile(resolve(assets, 'compare.js'), compareScript);
  await writeFile(resolve(assets, 'lucide.LICENSE'), await readFile(resolve(lucideRoot, 'LICENSE')));
}
