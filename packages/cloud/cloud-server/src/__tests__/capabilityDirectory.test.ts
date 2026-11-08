import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareCapabilitySnapshot } from '../../../../preset/dist/capabilitySnapshot.js';
vi.mock('../mode.js', () => ({ resolveCloudServerMode: () => 'sample' }));
import { main } from '../cli.js';
let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  delete (globalThis as any).__mearlCloudModeFixture;
});
async function install(hook: string, code: string) {
  directory = await mkdtemp(join(tmpdir(), 'mearl-cloud-plugin-'));
  vi.stubEnv('MEARL_CAPABILITY_DIR', directory);
  const bytes = Buffer.from(code), sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(directory, 'objects'));
  await writeFile(join(directory, 'objects', `${sha256}.cjs`), bytes);
  const snapshot = await prepareCapabilitySnapshot({ schemaVersion: 1, modules: { sample: { sha256, byteLength: bytes.length } }, bindings: { [hook]: { module: 'sample', handler: 'create' } } });
  await writeFile(join(directory, 'active-node.json'), JSON.stringify(snapshot));
}
it('loads a cloud mode from the shared custom directory without starting a server', async () => {
  await install('cloud.server.sample', 'module.exports = () => ({ create: () => { globalThis.__mearlCloudModeFixture = true; } })');
  expect(await main(['start'])).toBe(0);
  expect((globalThis as any).__mearlCloudModeFixture).toBe(true);
});
