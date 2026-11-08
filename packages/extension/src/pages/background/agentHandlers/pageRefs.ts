import {
  BackendNodeRefRegistry,
  enrichPageChangeSetWithRefs,
  resolveUniqueBackendNodeIds,
  type BackendNodeSnapshotRefAllocator,
  type PageChangeSet,
  type PageEffectRefEntry,
} from '@mearl/browser-core';
import { acquireDebuggerLease } from '../debuggerSessionManager';

export interface RefEntry extends PageEffectRefEntry {
  /** CDP frameId. Undefined for the main frame. */
  frameId?: string;
}

const refRegistriesByTab = new Map<number, BackendNodeRefRegistry<RefEntry>>();

function getRefRegistry(tabId: number): BackendNodeRefRegistry<RefEntry> {
  let registry = refRegistriesByTab.get(tabId);
  if (!registry) {
    registry = new BackendNodeRefRegistry<RefEntry>();
    refRegistriesByTab.set(tabId, registry);
  }
  return registry;
}

export function beginSnapshotRefs(tabId: number): BackendNodeSnapshotRefAllocator<RefEntry> {
  return getRefRegistry(tabId).beginSnapshot();
}

export function resolveRef(tabId: number, ref: string): RefEntry | undefined {
  return refRegistriesByTab.get(tabId)?.resolve(ref);
}

export function deleteRef(tabId: number, ref: string): void {
  refRegistriesByTab.get(tabId)?.delete(ref);
}

export function clearPageRefsForNavigation(tabId: number): void {
  refRegistriesByTab.get(tabId)?.clearDocument();
}

export function disposePageRefs(tabId: number): void {
  refRegistriesByTab.get(tabId)?.clearDocument();
  refRegistriesByTab.delete(tabId);
}

export async function enrichExtensionPageChangeSetWithRefs(
  tabId: number,
  observation: PageChangeSet,
): Promise<PageChangeSet> {
  const hasCandidates =
    observation.effects.interactives.some(effect => !effect.node.ref) ||
    (observation.effects.focus !== undefined && !observation.effects.focus.ref);
  if (!hasCandidates) return observation;

  const debuggerLease = await acquireDebuggerLease(tabId, {
    consumer: 'page-effect-refs',
  });
  try {
    const debugTarget = { tabId };
    return await enrichPageChangeSetWithRefs(
      observation,
      getRefRegistry(tabId),
      selectors =>
        resolveUniqueBackendNodeIds(
          (method, params) =>
            chrome.debugger.sendCommand(debugTarget, method, params) as Promise<any>,
          selectors,
        ),
      (node, backendNodeId) => ({
        backendNodeId,
        role: node.role ?? '',
        name: node.name ?? '',
      }),
    );
  } finally {
    await debuggerLease.release();
  }
}
