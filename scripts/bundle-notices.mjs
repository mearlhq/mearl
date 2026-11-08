import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Include notices for code present in bundle outputs, including bundled workspace dependency trees. */
export function writeBundleNotices(metafiles, workingDirectory, outputFile) {
  const inputs = new Set(metafiles.flatMap(metafile => Object.values(metafile.outputs).flatMap(output => Object.entries(output.inputs ?? {}).filter(([, input]) => input.bytesInOutput > 0).map(([name]) => name))));
  const packages = new Map();
  const owners = new Map();
  const owner = directory => {
    if (owners.has(directory)) return owners.get(directory);
    const manifestFile = join(directory, 'package.json');
    let result;
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') result = { directory, manifest };
    }
    if (!result && dirname(directory) !== directory) result = owner(dirname(directory));
    owners.set(directory, result);
    return result;
  };
  for (const input of inputs) {
    if (!input.replaceAll('\\', '/').split('/').includes('node_modules')) continue;
    const dependency = owner(dirname(resolve(workingDirectory, input)));
    if (!dependency) throw new Error(`Bundled dependency has no package metadata: ${input}`);
    const { manifest, directory } = dependency;
    if (manifest.name.startsWith('@mearl/')) continue;
    const id = `${manifest.name}@${manifest.version}`;
    if (packages.has(id)) continue;
    const files = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(entry.name)).map(entry => entry.name).sort();
    if (!files.length) throw new Error(`Bundled dependency has no license/notice file: ${id}`);
    packages.set(id, `${id}\n${files.map(file => `${file}\n\n${readFileSync(join(directory, file), 'utf8').trim()}\n`).join('\n')}`);
  }
  const text = [...packages].sort(([left], [right]) => left.localeCompare(right)).map(([, notice]) => notice).join('\n----------------------------------------\n\n');
  writeFileSync(outputFile, `Third-party code included in this bundle retains the following notices.\n\n${text}`);
  return [...packages.keys()].sort();
}
