import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DAEMON_HOME } from './paths.js';
import { verifyCapabilityActivation, MAX_CAPABILITY_SELECTION_BYTES, type CapabilityActivation } from '@mearl/preset';

export type NodeCapabilityHandler = (...args: any[]) => any;
export type NodeCapabilityHandlers = Record<string, NodeCapabilityHandler>;
export type NodeCapabilityFactory<Host extends object = object> = (host: Readonly<Host>, config: Record<string, unknown>) => NodeCapabilityHandlers | Promise<NodeCapabilityHandlers>;

const MAX_SELECTION_BYTES = MAX_CAPABILITY_SELECTION_BYTES + 128;
const handlerName = /^[a-z][a-zA-Z0-9_.-]{0,127}$/;

async function readBoundedFile(file: string, limit: number): Promise<Buffer> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Invalid Node capability resource file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit) throw new Error('Invalid Node capability resource file');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const read = await handle.read(bytes, length, bytes.byteLength - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new Error('Node capability resource exceeds its declared size');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

/** Locally installed, verified module bytes execute only in the Node host. */
export class NodeCapabilityRegistry<Host extends object = object> {
  readonly directory: string;
  private active: { snapshot: CapabilityActivation; handlers: NodeCapabilityHandlers; modules: Map<string, NodeCapabilityHandlers> } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly host: Readonly<Host>;
  private readonly hooks?: ReadonlySet<string>;

  constructor(host: Host, directory = join(DAEMON_HOME, 'capabilities'), options: { hooks?: readonly string[] } = {}) {
    if (options.hooks && (options.hooks.length > 256 || options.hooks.some(name => !handlerName.test(name)))) throw new Error('Invalid Node hook selection');
    this.hooks = options.hooks ? new Set(options.hooks) : undefined;
    this.directory = directory;
    this.host = Object.freeze({ ...host });
  }

  get revision(): string | undefined { return this.active?.snapshot.revision; }
  get installationRevision(): string | undefined { return this.active?.snapshot.installationRevision; }
  get<T extends NodeCapabilityHandler>(name: string): T | undefined { return this.active && Object.hasOwn(this.active.handlers, name) ? this.active.handlers[name] as T : undefined; }
  entries(prefix = ""): Array<[string, NodeCapabilityHandler]> {
    return Object.entries(this.active?.handlers ?? {}).filter(([name]) => name.startsWith(prefix));
  }
  require<T extends NodeCapabilityHandler>(name: string): T {
    const handler = this.get<T>(name);
    if (!handler) throw new Error(`Required capability is not installed: ${name}. Enable the preset that provides it.`);
    return handler;
  }

  refresh(): Promise<string | undefined> {
    const result = this.queue.catch(() => {}).then(async () => {
      let selection: CapabilityActivation | undefined;
      try { selection = await this.readSelection(); return await this.load(selection); }
      catch (error) {
        // A cold host can keep the installer's previous verified selection usable.
        if (!this.active) await this.restorePrevious(selection).catch(() => {});
        throw error;
      }
    });
    this.queue = result;
    return result;
  }

  private async readSelection(): Promise<CapabilityActivation | undefined> {
    const file = join(this.directory, 'active-node.json');
    let bytes;
    try { bytes = await readBoundedFile(file, MAX_SELECTION_BYTES); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    return verifyCapabilityActivation(JSON.parse(bytes.toString('utf8')));
  }

  private async load(snapshot: CapabilityActivation | undefined): Promise<string | undefined> {
    if (!snapshot) { this.active = undefined; return undefined; }
    if (snapshot.revision === this.active?.snapshot.revision) {
      this.active.snapshot = snapshot;
      return snapshot.revision;
    }
    return this.prepareSelection(snapshot, async () => {
      const current = await this.readSelection();
      return current?.revision === snapshot.revision ? current : undefined;
    });
  }

  private async restorePrevious(failed: CapabilityActivation | undefined): Promise<void> {
    const pointer = join(this.directory, 'active-node.json');
    const bytes = await readBoundedFile(pointer, MAX_SELECTION_BYTES);
    const requested = JSON.parse(bytes.toString('utf8')) as CapabilityActivation;
    const current = await verifyCapabilityActivation(requested).catch(() => undefined);
    if (current && (current.revision !== failed?.revision || current.installationRevision !== failed?.installationRevision)) {
      try { await this.load(current); return; } catch { /* A newer candidate can also require its verified rollback selection. */ }
    }
    if (typeof requested.installationRevision !== 'string' || !/^[a-f0-9]{64}$/.test(requested.installationRevision)) return;
    const record = JSON.parse((await readBoundedFile(join(this.directory, 'rollback.json'), MAX_SELECTION_BYTES + 256)).toString('utf8'));
    if (record.candidate !== requested.installationRevision || !record.previous) return;
    const previous = await verifyCapabilityActivation(record.previous);
    const expected = createHash('sha256').update(bytes).digest('hex');
    await this.prepareSelection(previous, async () => {
      const current = await readBoundedFile(pointer, MAX_SELECTION_BYTES);
      return createHash('sha256').update(current).digest('hex') === expected ? previous : undefined;
    });
  }

  private async prepareSelection(snapshot: CapabilityActivation, guard: () => Promise<CapabilityActivation | undefined>): Promise<string> {
    const bindings = Object.entries(snapshot.bindings).filter(([name]) => !this.hooks || this.hooks.has(name));
    const selected = new Set(bindings.map(([, binding]) => binding.module));
    const entries = Object.entries(snapshot.modules).filter(([id]) => !this.hooks || selected.has(id));
    const resources = new Map<string, Buffer>();
    for (const [id, resource] of entries) {
      const file = join(this.directory, 'objects', `${resource.sha256}.cjs`);
      const bytes = await readBoundedFile(file, resource.byteLength);
      if (bytes.byteLength !== resource.byteLength || createHash('sha256').update(bytes).digest('hex') !== resource.sha256) throw new Error(`Node capability integrity check failed: ${id}`);
      resources.set(id, bytes);
    }
    const modules = new Map<string, NodeCapabilityHandlers>();
    for (const [id, resource] of entries) {
      const previous = this.active?.snapshot.modules[id];
      const reusable = this.active?.modules.get(id);
      if (reusable && previous?.sha256 === resource.sha256 && previous.byteLength === resource.byteLength && isDeepStrictEqual(previous.config ?? {}, resource.config ?? {})) {
        modules.set(id, reusable);
        continue;
      }
      const bytes = resources.get(id)!;
      // CommonJS wrappers can be reclaimed after their active and in-flight handlers are released.
      const module: { exports: unknown } = { exports: {} };
      const execute = new Script(`(function(module,exports,require){\n${bytes.toString('utf8')}\n})`, { filename: `mearl-capability-${resource.sha256}.cjs` }).runInThisContext() as (module: { exports: unknown }, exports: unknown, require: NodeJS.Require) => void;
      execute(module, module.exports, createRequire(import.meta.url));
      const factory = typeof module.exports === 'function' ? module.exports : (module.exports as { default?: unknown } | null)?.default;
      const loaded = { default: factory as NodeCapabilityFactory<Host> | undefined };
      if (typeof loaded.default !== 'function') throw new Error(`Node capability ${id} requires a default factory`);
      const handlers = await loaded.default(this.host, structuredClone(resource.config ?? {}));
      if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers) || Object.keys(handlers).length > 256 || Object.entries(handlers).some(([name, handler]) => !handlerName.test(name) || typeof handler !== 'function')) throw new Error(`Invalid Node capability handlers: ${id}`);
      modules.set(id, handlers);
    }
    const handlers: NodeCapabilityHandlers = {};
    for (const [name, binding] of bindings) {
      const module = modules.get(binding.module)!;
      const handler = Object.hasOwn(module, binding.handler) ? module[binding.handler] : undefined;
      if (typeof handler !== 'function') throw new Error(`Node capability handler is missing: ${name}`);
      handlers[name] = handler;
    }
    const current = await guard();
    if (!current) throw new Error('Node capability selection changed while preparing modules');
    this.active = { snapshot: current, handlers: Object.freeze(handlers), modules };
    return snapshot.revision;
  }
}
