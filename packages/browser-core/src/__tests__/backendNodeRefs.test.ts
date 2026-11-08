import { describe, expect, it } from 'vitest';
import { BackendNodeRefRegistry } from '../backendNodeRefs.js';

interface Entry {
  backendNodeId: number;
  name: string;
}

describe('BackendNodeRefRegistry', () => {
  it('shares a monotonic ref sequence between snapshots and deltas', () => {
    const registry = new BackendNodeRefRegistry<Entry>();
    const snapshot = registry.beginSnapshot();
    const first = snapshot.register({ backendNodeId: 1, name: 'First' });
    const filtered = snapshot.register({ backendNodeId: 2, name: 'Filtered' });
    snapshot.commit(new Set([first]));

    expect(first).toBe('@e1');
    expect(filtered).toBe('@e2');
    expect(registry.resolve(first)?.name).toBe('First');
    expect(registry.resolve(filtered)).toBeUndefined();

    const delta = registry.registerDelta({ backendNodeId: 3, name: 'Delta' });
    expect(delta).toBe('@e3');

    const nextSnapshot = registry.beginSnapshot();
    const refreshed = nextSnapshot.register({ backendNodeId: 4, name: 'Refreshed' });
    nextSnapshot.commit(new Set([refreshed]));

    expect(refreshed).toBe('@e4');
    expect(registry.resolve(first)).toBeUndefined();
    expect(registry.resolve(delta)).toBeUndefined();
  });

  it('keeps concurrent snapshot and delta refs unique and active', () => {
    const registry = new BackendNodeRefRegistry<Entry>();
    const snapshot = registry.beginSnapshot();
    const snapshotRef = snapshot.register({ backendNodeId: 1, name: 'Snapshot' });
    const deltaRef = registry.registerDelta({ backendNodeId: 2, name: 'Delta' });

    snapshot.commit(new Set([snapshotRef]));

    expect(snapshotRef).toBe('@e1');
    expect(deltaRef).toBe('@e2');
    expect(registry.resolve(snapshotRef)?.name).toBe('Snapshot');
    expect(registry.resolve(deltaRef)?.name).toBe('Delta');
  });

  it('preserves an existing ref refreshed while a snapshot is running', () => {
    const registry = new BackendNodeRefRegistry<Entry>();
    const deltaRef = registry.registerDelta({ backendNodeId: 1, name: 'Before' });
    const snapshot = registry.beginSnapshot();
    const snapshotRef = snapshot.register({ backendNodeId: 2, name: 'Snapshot' });

    registry.registerDelta({ backendNodeId: 1, name: 'After' });
    snapshot.commit(new Set([snapshotRef]));

    expect(registry.resolve(deltaRef)?.name).toBe('After');
    expect(registry.resolve(snapshotRef)?.name).toBe('Snapshot');
  });

  it('preserves refs from snapshots that complete concurrently', () => {
    const registry = new BackendNodeRefRegistry<Entry>();
    const firstSnapshot = registry.beginSnapshot();
    const firstRef = firstSnapshot.register({ backendNodeId: 1, name: 'First' });
    const secondSnapshot = registry.beginSnapshot();
    const secondRef = secondSnapshot.register({ backendNodeId: 2, name: 'Second' });

    secondSnapshot.commit(new Set([secondRef]));
    firstSnapshot.commit(new Set([firstRef]));

    expect(registry.resolve(firstRef)?.name).toBe('First');
    expect(registry.resolve(secondRef)?.name).toBe('Second');
  });

  it('reuses the ref for an updated backend node', () => {
    const registry = new BackendNodeRefRegistry<Entry>();
    const first = registry.registerDelta({ backendNodeId: 7, name: 'Before' });
    const updated = registry.registerDelta({ backendNodeId: 7, name: 'After' });

    expect(updated).toBe(first);
    expect(registry.resolve(first)?.name).toBe('After');
    expect(registry.size).toBe(1);
  });

  it('bounds delta refs without evicting snapshot refs', () => {
    const registry = new BackendNodeRefRegistry<Entry>(2);
    const snapshot = registry.beginSnapshot();
    const stable = snapshot.register({ backendNodeId: 1, name: 'Stable' });
    snapshot.commit(new Set([stable]));

    const firstDelta = registry.registerDelta({ backendNodeId: 2, name: 'One' });
    const secondDelta = registry.registerDelta({ backendNodeId: 3, name: 'Two' });
    const thirdDelta = registry.registerDelta({ backendNodeId: 4, name: 'Three' });

    expect(registry.resolve(stable)).toBeDefined();
    expect(registry.resolve(firstDelta)).toBeUndefined();
    expect(registry.resolve(secondDelta)).toBeDefined();
    expect(registry.resolve(thirdDelta)).toBeDefined();
  });

  it('clears document mappings without reusing exposed ref values', () => {
    const registry = new BackendNodeRefRegistry<Entry>();
    const oldRef = registry.registerDelta({ backendNodeId: 1, name: 'Old document' });
    registry.clearDocument();
    const newRef = registry.registerDelta({ backendNodeId: 1, name: 'New document' });

    expect(oldRef).toBe('@e1');
    expect(newRef).toBe('@e2');
    expect(registry.resolve(oldRef)).toBeUndefined();
  });

  it('rejects an in-flight snapshot after the document changes', () => {
    const registry = new BackendNodeRefRegistry<Entry>();
    const snapshot = registry.beginSnapshot();
    const staleRef = snapshot.register({ backendNodeId: 1, name: 'Stale' });

    registry.clearDocument();

    expect(() => snapshot.commit(new Set([staleRef]))).toThrow(
      'page document changed while refs were being collected',
    );
    expect(registry.resolve(staleRef)).toBeUndefined();
  });
});
