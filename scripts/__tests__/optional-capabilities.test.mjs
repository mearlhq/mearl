import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { preparePreset, prepareBrowserBundleSnapshot } from '../../packages/preset/dist/bundles.js';
import { prepareNodeBundleSnapshot } from '../../packages/preset/dist/index.js';
import { NodeCapabilityRegistry } from '../../packages/daemon-core/dist/node-capabilities.js';

it.each(['tracking', 'qoder'])('installs the actual %s npm bundle through the shared verified registry', async name => {
  const source = new URL(`../../packages/plugin-${name}/dist/capability/preset.json`, import.meta.url);
  const prepared = await preparePreset(source.href, { mearlApiVersion: '1.0.0', load: url => readFile(new URL(url)) });
  const node = await prepareNodeBundleSnapshot(prepared.bundles, 'native-host', '1.0.0');
  const directory = await mkdtemp(join(tmpdir(), 'mearl-optional-'));
  try {
    await mkdir(join(directory, 'objects'));
    for (const [sha, bytes] of Object.entries(node.resources)) await writeFile(join(directory, 'objects', `${sha}.cjs`), bytes);
    await writeFile(join(directory, 'active-node.json'), JSON.stringify(node.snapshot));
    const registry = new NodeCapabilityRegistry({}, directory);
    await registry.refresh();
    if (name === 'tracking') {
      expect(registry.require('tracking.request')().matches('https://gm.mmstat.com/report')).toBe(true);
      const browser = await prepareBrowserBundleSnapshot(prepared.bundles, 'extension', '1.0.0');
      expect(Object.keys(browser.snapshot.bindings).sort()).toEqual(['tracking.decode', 'tracking.spm']);
    } else {
      expect(registry.entries('agent.provider.').map(([id]) => id)).toEqual(['agent.provider.qoder']);
      expect(registry.get('cloud.connector.qoder')).toBeTypeOf('function');
      const provider = registry.require('agent.provider.qoder')({ log() {}, version: 'test' });
      expect(provider.id).toBe('qoder');
      provider.dispose();
    }
    await rm(join(directory, 'active-node.json'));
    await registry.refresh();
    expect(registry.entries()).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
