import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareCapabilitySnapshot, type CapabilitySelection } from '@mearl/preset';
import { NodeCapabilityRegistry } from '../node-capabilities.js';
interface FixtureHost { version: string }

let directory: string;
let registry: NodeCapabilityRegistry<FixtureHost>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mearl-node-capabilities-'));
  registry = new NodeCapabilityRegistry({ version: '3.0.0' }, directory);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function select(code: string, handler = 'value') {
  const bytes = Buffer.from(code);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(directory, 'objects'), { recursive: true });
  await writeFile(join(directory, 'objects', `${sha256}.cjs`), bytes);
  const snapshot = await prepareCapabilitySnapshot({ schemaVersion: 1, modules: { sample: { sha256, byteLength: bytes.byteLength, config: { number: 7 } } }, bindings: { 'sample.value': { module: 'sample', handler } } });
  await writeFile(join(directory, 'active-node.json'), JSON.stringify(snapshot));
  return snapshot;
}
async function selectWithOther(first: CapabilitySelection, number: number) {
  const bytes = Buffer.from('module.exports = (_, config) => ({ value: () => config.number })');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'objects', `${sha256}.cjs`), bytes);
  const snapshot = await prepareCapabilitySnapshot({ schemaVersion: 1,
    modules: { ...first.modules, other: { sha256, byteLength: bytes.length, config: { number } } },
    bindings: { ...first.bindings, 'other.value': { module: 'other', handler: 'value' } },
  });
  await writeFile(join(directory, 'active-node.json'), JSON.stringify(snapshot));
  return snapshot;
}
describe('verified Node capability loading', () => {
  it('preserves unchanged handlers when another module is added, configured or removed', async () => {
    const first = await select('module.exports = (_, config) => ({ value: () => config.number })');
    await registry.refresh();
    const pinned = registry.require('sample.value');
    await selectWithOther(first, 1); await registry.refresh();
    const other = registry.require('other.value');
    expect(registry.require('sample.value')).toBe(pinned);
    await selectWithOther(first, 2); await registry.refresh();
    expect(registry.require('sample.value')).toBe(pinned);
    expect(registry.require('other.value')).not.toBe(other);
    expect(registry.require('other.value')()).toBe(2);
    expect(other()).toBe(1);
    await writeFile(join(directory, 'active-node.json'), JSON.stringify(first));
    await registry.refresh();
    expect(registry.require('sample.value')).toBe(pinned);
    expect(registry.get('other.value')).toBeUndefined();
  });
  it('checks unchanged module bytes before accepting an unrelated update', async () => {
    const first = await select('module.exports = () => ({ value: () => "usable" })');
    await registry.refresh();
    const pinned = registry.require('sample.value');
    await selectWithOther(first, 1);
    await writeFile(join(directory, 'objects', `${first.modules.sample.sha256}.cjs`), 'damaged');
    await expect(registry.refresh()).rejects.toThrow('integrity');
    expect(registry.require('sample.value')).toBe(pinned);
    expect(registry.get('other.value')).toBeUndefined();
  });
  it('keeps handler identity when configuration object keys are reordered', async () => {
    const first = await select('module.exports = (_, config) => ({ value: () => config })');
    const configured = async (config: Record<string, any>) => {
      const snapshot = await prepareCapabilitySnapshot({ schemaVersion: 1, modules: { sample: { ...first.modules.sample, config } }, bindings: first.bindings });
      await writeFile(join(directory, 'active-node.json'), JSON.stringify(snapshot));
      await registry.refresh();
    };
    await configured({ number: 7, nested: { enabled: true, label: 'value' } });
    const pinned = registry.require('sample.value');
    await configured({ nested: { label: 'value', enabled: true }, number: 7 });
    expect(registry.require('sample.value')).toBe(pinned);
  });
  it('loads configured hooks without changing in-flight function references', async () => {
    const first = await select('module.exports = (host, config) => ({ value: () => host.version + ":" + config.number })');
    await expect(registry.refresh()).resolves.toBe(first.revision);
    const pinned = registry.require<() => string>('sample.value');
    expect(pinned()).toBe('3.0.0:7');
    await select('module.exports = () => ({ value: () => "updated" })');
    await registry.refresh();
    expect(registry.require<() => string>('sample.value')()).toBe('updated');
    expect(pinned()).toBe('3.0.0:7');
  });
  it('keeps active hooks after a corrupt update', async () => {
    await select('module.exports = () => ({ value: () => "usable" })'); await registry.refresh();
    const oldRevision = registry.revision;
    const next = await select('module.exports = () => ({ value: () => "corrupt" })');
    await writeFile(join(directory, 'objects', `${next.modules.sample.sha256}.cjs`), 'invalid');
    await expect(registry.refresh()).rejects.toThrow('integrity');
    expect(registry.revision).toBe(oldRevision);
    expect(registry.require<() => string>('sample.value')()).toBe('usable');
  });
  it('imports verified bytes instead of executing replaced files later', async () => {
    const selection = await select('module.exports = () => ({ value: () => "verified" })'); await registry.refresh();
    await writeFile(join(directory, 'objects', `${selection.modules.sample.sha256}.cjs`), 'throw new Error("replaced")');
    expect(registry.require<() => string>('sample.value')()).toBe('verified');
  });
  it('rejects missing exports without replacing an active selection', async () => {
    await select('module.exports = () => ({ value: () => "usable" })'); await registry.refresh();
    await select('module.exports = () => ({ other: () => true })');
    await expect(registry.refresh()).rejects.toThrow('missing');
    expect(registry.require<() => string>('sample.value')()).toBe('usable');
  });
  it('clears hooks when the explicit selection is removed', async () => {
    await select('module.exports = () => ({ value: () => "usable" })'); await registry.refresh();
    await rm(join(directory, 'active-node.json')); await registry.refresh();
    expect(registry.get('sample.value')).toBeUndefined();
    expect(() => registry.require('sample.value')).toThrow('not installed');
  });
  it('updates installation identity without re-executing unchanged modules', async () => {
    const first = await select('globalThis.__mearlFactoryStarts = (globalThis.__mearlFactoryStarts ?? 0) + 1; module.exports = () => ({ value: () => "usable" })');
    try {
      await registry.refresh();
      const pinned = registry.get('sample.value');
      await writeFile(join(directory, 'active-node.json'), JSON.stringify({ ...first, installationRevision: 'a'.repeat(64) }));
      await registry.refresh();
      expect(registry.installationRevision).toBe('a'.repeat(64));
      expect(registry.get('sample.value')).toBe(pinned);
      expect((globalThis as any).__mearlFactoryStarts).toBe(1);
    } finally { delete (globalThis as any).__mearlFactoryStarts; }
  });
  it('restores a verified rollback selection on cold-start rejection while reporting the failure', async () => {
    const previous = { ...await select('module.exports = () => ({ value: () => "previous" })'), installationRevision: 'a'.repeat(64) };
    const candidate = { ...await select('module.exports = () => { throw new Error("candidate rejected") }'), installationRevision: 'b'.repeat(64) };
    await writeFile(join(directory, 'active-node.json'), JSON.stringify(candidate));
    await writeFile(join(directory, 'rollback.json'), JSON.stringify({ candidate: candidate.installationRevision, previous }));
    await expect(registry.refresh()).rejects.toThrow('candidate rejected');
    expect(registry.require<() => string>('sample.value')()).toBe('previous');
    expect(registry.installationRevision).toBe(previous.installationRevision);
  });
  it('refuses a rollback record belonging to another candidate', async () => {
    const previous = await select('module.exports = () => ({ value: () => "previous" })');
    const candidate = { ...await select('module.exports = () => { throw new Error("candidate rejected") }'), installationRevision: 'b'.repeat(64) };
    await writeFile(join(directory, 'active-node.json'), JSON.stringify(candidate));
    await writeFile(join(directory, 'rollback.json'), JSON.stringify({ candidate: 'c'.repeat(64), previous }));
    await expect(registry.refresh()).rejects.toThrow('candidate rejected');
    expect(registry.revision).toBeUndefined();
  });
  it('loads the current selection when another host completes rollback during a cold factory', async () => {
    const previous = { ...await select('module.exports = () => ({ value: () => "previous" })'), installationRevision: 'a'.repeat(64) };
    let release!: () => void;
    (globalThis as any).__mearlColdFactoryGate = new Promise<void>(resolve => { release = resolve; });
    const candidate = { ...await select('module.exports = async () => { globalThis.__mearlColdFactoryStarted = true; await globalThis.__mearlColdFactoryGate; throw new Error("candidate rejected") }'), installationRevision: 'b'.repeat(64) };
    await writeFile(join(directory, 'active-node.json'), JSON.stringify(candidate));
    await writeFile(join(directory, 'rollback.json'), JSON.stringify({ candidate: candidate.installationRevision, previous }));
    const loading = registry.refresh();
    const rejected = expect(loading).rejects.toThrow('candidate rejected');
    try {
      const deadline = Date.now() + 1000;
      while (!(globalThis as any).__mearlColdFactoryStarted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
      expect((globalThis as any).__mearlColdFactoryStarted).toBe(true);
      await writeFile(join(directory, 'active-node.json'), JSON.stringify(previous));
      await rm(join(directory, 'rollback.json'));
      release();
      await rejected;
      expect(registry.installationRevision).toBe(previous.installationRevision);
      expect(registry.require<() => string>('sample.value')()).toBe('previous');
    } finally {
      release();
      delete (globalThis as any).__mearlColdFactoryGate;
      delete (globalThis as any).__mearlColdFactoryStarted;
    }
  });
});


it('does not treat inherited object methods as hooks or module exports', async () => {
  await select('module.exports = () => ({ value: () => true })'); await registry.refresh();
  expect(registry.get('toString')).toBeUndefined();
  await select('module.exports = () => ({})', 'toString');
  await expect(registry.refresh()).rejects.toThrow('missing');
});

it('verifies every resource before evaluating any module', async () => {
  const bytes = Buffer.from('globalThis.__mearlNodeProbe = true; module.exports = () => ({ value: () => true })');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(directory, 'objects'), { recursive: true });
  await writeFile(join(directory, 'objects', `${sha256}.cjs`), bytes);
  const snapshot = await prepareCapabilitySnapshot({ schemaVersion: 1, modules: {
    first: { sha256, byteLength: bytes.byteLength },
    second: { sha256: 'b'.repeat(64), byteLength: 3 },
  }, bindings: {} });
  await writeFile(join(directory, 'active-node.json'), JSON.stringify(snapshot));
  try {
    await expect(registry.refresh()).rejects.toThrow();
    expect((globalThis as any).__mearlNodeProbe).toBeUndefined();
  } finally { delete (globalThis as any).__mearlNodeProbe; }
});

it('loads only requested hook modules while retaining the full verified selection identity', async () => {
  const snapshot = await select('module.exports = () => ({ value: () => "selected" })');
  const bytes = Buffer.from('throw new Error("Provider host must not start")');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'objects', hash + '.cjs'), bytes);
  const full = await prepareCapabilitySnapshot({ schemaVersion: 1, modules: { ...snapshot.modules, browser: { sha256: hash, byteLength: bytes.length } }, bindings: { ...snapshot.bindings, 'browser.open': { module: 'browser', handler: 'open' } } });
  await writeFile(join(directory, 'active-node.json'), JSON.stringify(full));
  const scoped = new NodeCapabilityRegistry({ version: '3.0.0' }, directory, { hooks: ['sample.value'] });
  expect(await scoped.refresh()).toBe(full.revision);
  expect(scoped.require<() => string>('sample.value')()).toBe('selected');
  expect(scoped.get('browser.open')).toBeUndefined();
  await expect(registry.refresh()).rejects.toThrow('Provider host must not start');
  await writeFile(join(directory, 'objects', snapshot.modules.sample.sha256 + '.cjs'), 'damaged');
  await expect(scoped.refresh()).resolves.toBe(full.revision);
  const cold = new NodeCapabilityRegistry({ version: '3.0.0' }, directory, { hooks: ['sample.value'] });
  await expect(cold.refresh()).rejects.toThrow();
});
