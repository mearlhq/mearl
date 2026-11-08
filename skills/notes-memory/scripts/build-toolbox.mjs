import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fromWorkspace = createRequire(resolve(root, 'package.json'));
const assets = fileURLToPath(new URL('../assets/toolbox/', import.meta.url));
const lucideRoot = dirname(fromWorkspace.resolve('lucide-react/package.json'));
const icons = {};
for (const [name, filename] of Object.entries({
  plus: 'plus', trash: 'trash-2', clear: 'brush-cleaning', search: 'search', restore: 'archive-restore',
  bot: 'bot', remove: 'file-x', close: 'x', image: 'image-plus', capture: 'text-select',
})) {
  const icon = await readFile(resolve(lucideRoot, `dist/esm/icons/${filename}.js`), 'utf8');
  const literal = icon.match(/const __iconNode = (\[[\s\S]*?\]);/)[1];
  icons[name] = runInNewContext(`(${literal})`).map(([tag, attributes]) => {
    delete attributes.key;
    return [tag, attributes];
  });
}
const iconScript = '// Lucide icon nodes; see lucide.LICENSE.\nwindow.notesIcons = ' + JSON.stringify(icons) + ';\n';
if (process.argv.includes('--check')) {
  if (await readFile(resolve(assets, 'icons.js'), 'utf8') !== iconScript) throw new Error('Notes icons are outdated');
} else {
  await writeFile(resolve(assets, 'icons.js'), iconScript);
  await writeFile(resolve(assets, 'lucide.LICENSE'), await readFile(resolve(lucideRoot, 'LICENSE')));
}
