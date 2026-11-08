import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProcessOwnerAlive, processIdentity } from '../process.js';
import { NodePageRuntimeStore } from '../page-runtimes.js';

vi.mock('../process.js', async importOriginal => { const actual = await importOriginal<typeof import('../process.js')>(); return { ...actual, isProcessOwnerAlive: vi.fn(actual.isProcessOwnerAlive) }; });

let directory: string;
const binding = (source: string) => ({ id: 'sample/runtime', sha256: createHash('sha256').update(source).digest('hex') });
const owner = { browser: 'a'.repeat(64), target: 'page-one', pid: process.pid, processIdentity: processIdentity(process.pid) };
const codeFile = (source: string) => join(directory, 'page-runtimes', `${binding(source).sha256}.cjs`);
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'mearl-node-page-store-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
describe('Node page runtime persistence and reclamation', () => {
  it('restores exact code offline across host instances and retains it while the browser target lives', () => {
    new NodePageRuntimeStore(directory).resolve(binding('first'), () => 'first', owner);
    const store = new NodePageRuntimeStore(directory);
    store.reconcile(owner.browser, new Set([owner.target]));
    expect(store.resolve(binding('first'), undefined, owner)).toBe('first');
    store.reconcile(owner.browser, new Set());
    expect(existsSync(codeFile('first'))).toBe(false);
  });
  it('bounds stored bytes without evicting active or disconnected remote browser references', () => {
    const store = new NodePageRuntimeStore(directory, 8);
    const remote = { browser: 'b'.repeat(64), target: 'remote' };
    store.resolve(binding('first'), () => 'first', remote);
    expect(() => store.resolve(binding('next'), () => 'next', owner)).toThrow('active browser');
    expect(store.resolve(binding('first'))).toBe('first');
    store.release(remote);
    expect(store.resolve(binding('next'), () => 'next', owner)).toBe('next');
  });
  it('keeps current and pending navigation code until a document transition releases old versions', () => {
    const store = new NodePageRuntimeStore(directory);
    store.resolve(binding('first'), () => 'first', owner);
    store.resolve(binding('next'), () => 'next', owner);
    expect(store.resolve(binding('first'))).toBe('first');
    store.retain(owner, binding('next'));
    expect(existsSync(codeFile('first'))).toBe(false);
    expect(store.resolve(binding('next'))).toBe('next');
    store.release(owner);
    expect(existsSync(codeFile('next'))).toBe(false);
  });
  it('reclaims references when a local browser process has been replaced', () => {
    const store = new NodePageRuntimeStore(directory, 8);
    store.resolve(binding('first'), () => 'first', { ...owner, processIdentity: 'exited-browser' });
    expect(store.resolve(binding('next'), () => 'next', owner)).toBe('next');
    expect(existsSync(codeFile('first'))).toBe(false);
  });
  it('fails closed on corrupted cached code without changing the reference graph', () => {
    const store = new NodePageRuntimeStore(directory);
    store.resolve(binding('first'), () => 'first', owner);
    const index = join(directory, 'page-runtimes', 'references.json');
    const before = readFileSync(index, 'utf8');
    writeFileSync(codeFile('first'), 'other');
    expect(() => store.resolve(binding('first'), () => 'first', owner)).toThrow('integrity');
    expect(readFileSync(index, 'utf8')).toBe(before);
  });
});

it('checks each local browser process only once per cache mutation across many targets', () => {
  const store = new NodePageRuntimeStore(directory);
  for (let index = 0; index < 8; index++) store.resolve(binding('first'), () => 'first', { ...owner, target: `page-${index}` });
  vi.mocked(isProcessOwnerAlive).mockClear();
  expect(store.resolve(binding('first'), undefined, owner)).toBe('first');
  expect(isProcessOwnerAlive).toHaveBeenCalledTimes(1);
});
