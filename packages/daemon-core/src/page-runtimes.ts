import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_HOME } from './paths.js';
import { isProcessOwnerAlive } from './process.js';
import { withRecordLock } from './registry.js';
import { MAX_PAGE_RUNTIME_BYTES, type PageRuntimeBinding } from '@mearl/preset/bundles';

export interface PageRuntimeOwner { browser: string; target: string; pid?: number; processIdentity?: string }
interface RuntimeReferences { owners: Record<string, PageRuntimeOwner & { digests: string[] }> }
const sha256 = /^[a-f0-9]{64}$/;
export const MAX_NODE_PAGE_CACHE_BYTES = 64 * 1024 * 1024;
export function capabilityDirectory(): string { return process.env.MEARL_CAPABILITY_DIR || join(DAEMON_HOME, 'capabilities'); }

/** Browser references survive host restarts; unavailable remote browsers retain their exact code. */
export class NodePageRuntimeStore {
  private readonly root: string;
  private readonly index: string;
  constructor(directory = capabilityDirectory(), private readonly quota = MAX_NODE_PAGE_CACHE_BYTES) {
    this.root = join(directory, 'page-runtimes');
    this.index = join(this.root, 'references.json');
  }
  resolve(binding: PageRuntimeBinding, provide?: (binding: PageRuntimeBinding) => string | undefined, owner?: PageRuntimeOwner): string {
    if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(binding.id) || !sha256.test(binding.sha256)) throw new Error('Invalid page runtime binding');
    return this.mutate(references => {
      const file = join(this.root, `${binding.sha256}.cjs`);
      let source: string;
      if (existsSync(file)) source = this.verify(binding, this.read(file, MAX_PAGE_RUNTIME_BYTES));
      else {
        const provided = provide?.(binding);
        if (typeof provided !== 'string' || !provided.trim()) throw new Error(`Required page runtime is not installed: ${binding.id}@${binding.sha256}`);
        const bytes = Buffer.from(provided);
        source = this.verify(binding, bytes);
        this.collect(references, bytes.byteLength, 1);
        this.write(file, bytes);
      }
      if (owner) {
        if (!sha256.test(owner.browser) || !owner.target || owner.target.length > 256) throw new Error('Invalid page runtime owner');
        const key = this.key(owner);
        const previous = references.owners[key];
        if (!previous && Object.keys(references.owners).length >= 4096) throw new Error('Page runtime reference limit exceeded');
        references.owners[key] = { ...owner, digests: [...new Set([...(previous?.digests ?? []), binding.sha256])] };
      }
      return source;
    });
  }
  release(owner: PageRuntimeOwner): void {
    if (!existsSync(this.index)) return;
    this.mutate(references => { delete references.owners[this.key(owner)]; this.collect(references); });
  }
  retain(owner: PageRuntimeOwner, binding?: PageRuntimeBinding): void {
    if (!existsSync(this.index)) return;
    this.mutate(references => {
      const previous = references.owners[this.key(owner)];
      if (previous && binding && previous.digests.includes(binding.sha256)) previous.digests = [binding.sha256];
      else if (!binding) delete references.owners[this.key(owner)];
      this.collect(references);
    });
  }
  /** A live target inventory is authoritative after a disconnected host lost close events. */
  reconcile(browser: string, targets: ReadonlySet<string>): void {
    if (!existsSync(this.index)) return;
    this.mutate(references => {
      for (const [key, owner] of Object.entries(references.owners)) if (owner.browser === browser && !targets.has(owner.target)) delete references.owners[key];
      this.collect(references);
    });
  }
  private key(owner: PageRuntimeOwner): string { return createHash('sha256').update(JSON.stringify([owner.browser, owner.target])).digest('hex'); }
  private mutate<T>(action: (references: RuntimeReferences) => T): T {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    return withRecordLock(this.index, () => {
      const references: RuntimeReferences = existsSync(this.index) ? JSON.parse(this.read(this.index, 4 * 1024 * 1024).toString('utf8')) : { owners: {} };
      if (!references || !references.owners || typeof references.owners !== 'object' || Array.isArray(references.owners) || Object.keys(references.owners).length > 4096) throw new Error('Invalid page runtime reference index');
      const liveness = new Map<string, boolean>();
      for (const [key, owner] of Object.entries(references.owners)) {
        if (!owner || !sha256.test(owner.browser) || typeof owner.target !== 'string' || !Array.isArray(owner.digests) || owner.digests.length > 256 || owner.digests.some(digest => typeof digest !== 'string' || !sha256.test(digest))) throw new Error('Invalid page runtime reference');
        if (owner.pid !== undefined) {
          const identity = JSON.stringify([owner.pid, owner.processIdentity]);
          if (!liveness.has(identity)) liveness.set(identity, isProcessOwnerAlive({ pid: owner.pid, processIdentity: owner.processIdentity }));
          if (!liveness.get(identity)) delete references.owners[key];
        }
      }
      const result = action(references);
      const bytes = Buffer.from(JSON.stringify(references));
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('Page runtime reference index exceeds 4 MiB');
      this.write(this.index, bytes);
      return result;
    });
  }
  private collect(references: RuntimeReferences, requiredBytes = 0, requiredEntries = 0): void {
    const protectedDigests = new Set(Object.values(references.owners).flatMap(owner => owner.digests));
    const files = readdirSync(this.root).filter(name => /^[a-f0-9]{64}\.cjs$/.test(name)).map(name => ({ file: join(this.root, name), digest: name.slice(0, 64), info: statSync(join(this.root, name)) }));
    let total = files.reduce((sum, file) => sum + file.info.size, 0);
    let entries = files.length;
    for (const file of files.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
      if (protectedDigests.has(file.digest)) continue;
      // Explicit release/reconciliation reclaims unreferenced objects; insertions evict as needed.
      if (requiredBytes && total + requiredBytes <= this.quota && entries + requiredEntries <= 256) break;
      unlinkSync(file.file); total -= file.info.size; entries--;
    }
    if (total + requiredBytes > this.quota || entries + requiredEntries > 256) throw new Error('Page runtime cache is full of active browser references');
  }
  private read(file: string, maximum: number): Buffer {
    const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(handle);
      if (!stat.isFile() || stat.size > maximum) throw new Error('Stored page runtime exceeds its limit');
      const bytes = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < bytes.length) { const count = readSync(handle, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
      if (length > maximum) throw new Error('Stored page runtime exceeds its limit');
      return bytes.subarray(0, length);
    } finally { closeSync(handle); }
  }
  private write(file: string, bytes: Buffer): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
    finally { try { unlinkSync(temporary); } catch { /* Atomic replacement consumed the temporary file. */ } }
  }
  private verify(binding: PageRuntimeBinding, bytes: Buffer): string {
    if (bytes.byteLength > MAX_PAGE_RUNTIME_BYTES || createHash('sha256').update(bytes).digest('hex') !== binding.sha256) throw new Error('Page runtime integrity check failed');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
}
