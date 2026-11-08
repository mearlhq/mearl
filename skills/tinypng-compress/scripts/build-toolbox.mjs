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
  image: 'image', paste: 'clipboard-paste', download: 'download', trash: 'trash-2',
  copy: 'copy', loader: 'loader-circle', retry: 'refresh-cw', close: 'x',
})) {
  const icon = await readFile(resolve(lucideRoot, `dist/esm/icons/${filename}.js`), 'utf8');
  const literal = icon.match(/const __iconNode = (\[[\s\S]*?\]);/)[1];
  icons[name] = runInNewContext(`(${literal})`).map(([tag, attributes]) => {
    delete attributes.key;
    return [tag, attributes];
  });
}
const iconScript = '// Lucide icon nodes; see lucide.LICENSE.\nwindow.imageCompressIcons = ' + JSON.stringify(icons) + ';\n';
if (process.argv.includes('--check')) {
  if (await readFile(resolve(assets, 'icons.js'), 'utf8') !== iconScript) throw new Error('Image compression icons are outdated');
} else {
  await writeFile(resolve(assets, 'icons.js'), iconScript);
  await writeFile(resolve(assets, 'lucide.LICENSE'), await readFile(resolve(lucideRoot, 'LICENSE')));
}
