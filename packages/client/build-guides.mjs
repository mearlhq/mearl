import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { GUIDE_TOPICS, renderGuideLinks } from './dist/guide.js';

const source = new URL('./guides/', import.meta.url);
const output = new URL('./dist/guides/', import.meta.url);
const assets = await Promise.all(GUIDE_TOPICS.map(async topic => {
  const body = await readFile(new URL(topic.file, source), 'utf8');
  renderGuideLinks(body); // All local links must resolve within the shipped catalog.
  return { file: topic.file, body };
}));
if (process.argv.includes('--check')) {
  const files = await readdir(output);
  if (JSON.stringify(files.sort()) !== JSON.stringify(assets.map(asset => asset.file).sort())) throw new Error('Runtime guide resource set has drifted');
  for (const asset of assets) if (await readFile(new URL(asset.file, output), 'utf8') !== asset.body) throw new Error(`Runtime guide has drifted: ${asset.file}`);
  console.log('Runtime guides match the canonical CLI sources.');
} else {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const asset of assets) await writeFile(new URL(asset.file, output), asset.body);
}
