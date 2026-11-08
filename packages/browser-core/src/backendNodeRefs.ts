export interface BackendNodeRefEntry {
  backendNodeId: number;
}

export interface BackendNodeSnapshotRefAllocator<T extends BackendNodeRefEntry> {
  register(entry: T): string;
  commit(outputRefs: ReadonlySet<string>): void;
}

export interface BackendNodeDeltaRefAllocator<T extends BackendNodeRefEntry> {
  register(entry: T): string;
}

interface BackendNodeRefRecord<T extends BackendNodeRefEntry> {
  entry: T;
  mutationId: number;
}

/**
 * Keeps user-facing refs unique for the lifetime of one browser tab while
 * allowing each document snapshot to replace the currently valid ref set.
 * Delta refs reuse an existing backend node mapping and are bounded separately
 * so long-running action loops cannot grow the registry without limit.
 */
export class BackendNodeRefRegistry<T extends BackendNodeRefEntry> {
  private nextRefId = 0;
  private nextMutationId = 0;
  private documentGeneration = 0;
  private entries = new Map<string, BackendNodeRefRecord<T>>();
  private refsByBackendNodeId = new Map<number, string>();
  private deltaRefOrder: string[] = [];

  constructor(private readonly maxDeltaRefs = 512) {
    if (!Number.isInteger(maxDeltaRefs) || maxDeltaRefs < 1) {
      throw new Error('maxDeltaRefs must be a positive integer');
    }
  }

  resolve(ref: string): T | undefined {
    return this.entries.get(ref)?.entry;
  }

  registerDelta(entry: T): string {
    return this.registerDeltaForDocument(entry, this.documentGeneration);
  }

  beginDelta(): BackendNodeDeltaRefAllocator<T> {
    const documentGeneration = this.documentGeneration;
    return {
      register: (entry: T): string => this.registerDeltaForDocument(entry, documentGeneration),
    };
  }

  private registerDeltaForDocument(entry: T, documentGeneration: number): string {
    this.assertDocumentGeneration(documentGeneration);
    const mutationId = this.allocateMutationId();
    const existingRef = this.refsByBackendNodeId.get(entry.backendNodeId);
    if (existingRef && this.entries.has(existingRef)) {
      this.entries.set(existingRef, { entry, mutationId });
      return existingRef;
    }

    const ref = this.allocateRef();
    this.entries.set(ref, { entry, mutationId });
    this.refsByBackendNodeId.set(entry.backendNodeId, ref);
    this.deltaRefOrder.push(ref);
    this.evictOverflowingDeltaRefs();
    return ref;
  }

  beginSnapshot(): BackendNodeSnapshotRefAllocator<T> {
    const documentGeneration = this.documentGeneration;
    const startedAtMutationId = this.nextMutationId;
    let committed = false;
    const candidates = new Map<string, T>();

    return {
      register: (entry: T): string => {
        if (committed) throw new Error('snapshot ref allocator has already been committed');
        const ref = this.allocateRef();
        candidates.set(ref, entry);
        return ref;
      },
      commit: (outputRefs: ReadonlySet<string>): void => {
        if (committed) throw new Error('snapshot ref allocator has already been committed');
        committed = true;
        this.assertDocumentGeneration(documentGeneration);

        const entries = new Map<string, BackendNodeRefRecord<T>>();
        const refsByBackendNodeId = new Map<number, string>();
        const snapshotMutationId = this.allocateMutationId();
        for (const [ref, entry] of candidates) {
          if (!outputRefs.has(ref)) continue;
          entries.set(ref, { entry, mutationId: snapshotMutationId });
          refsByBackendNodeId.set(entry.backendNodeId, ref);
        }

        // Preserve refs that were created or refreshed after this snapshot
        // started. This keeps concurrent action results and newer snapshots
        // usable without retaining refs from older completed snapshots.
        for (const [ref, record] of this.entries) {
          if (record.mutationId <= startedAtMutationId) continue;
          entries.set(ref, record);
          refsByBackendNodeId.set(record.entry.backendNodeId, ref);
        }

        this.entries = entries;
        this.refsByBackendNodeId = refsByBackendNodeId;
        this.deltaRefOrder = this.deltaRefOrder.filter(ref => entries.has(ref));
      },
    };
  }

  delete(ref: string): void {
    const record = this.entries.get(ref);
    if (!record) return;
    this.entries.delete(ref);
    if (this.refsByBackendNodeId.get(record.entry.backendNodeId) === ref) {
      this.refsByBackendNodeId.delete(record.entry.backendNodeId);
    }
    const deltaIndex = this.deltaRefOrder.indexOf(ref);
    if (deltaIndex >= 0) this.deltaRefOrder.splice(deltaIndex, 1);
  }

  clearDocument(): void {
    this.documentGeneration += 1;
    this.entries.clear();
    this.refsByBackendNodeId.clear();
    this.deltaRefOrder = [];
  }

  get size(): number {
    return this.entries.size;
  }

  private allocateRef(): string {
    this.nextRefId += 1;
    return `@e${this.nextRefId}`;
  }

  private allocateMutationId(): number {
    this.nextMutationId += 1;
    return this.nextMutationId;
  }

  private assertDocumentGeneration(documentGeneration: number): void {
    if (documentGeneration !== this.documentGeneration) {
      throw new Error('page document changed while refs were being collected');
    }
  }

  private evictOverflowingDeltaRefs(): void {
    while (this.deltaRefOrder.length > this.maxDeltaRefs) {
      const ref = this.deltaRefOrder.shift();
      if (ref) this.delete(ref);
    }
  }
}
