import {
  BackendNodeRefRegistry,
  enrichPageChangeSetWithRefs,
  resolveUniqueBackendNodeIds,
  type BackendNodeSnapshotRefAllocator,
  type PageChangeSet,
  type PageEffectRefEntry,
} from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import { sendCdpDeviceShellPageCommand } from './device-shell.js';

export type PageRefEntry = PageEffectRefEntry;

const registries = new WeakMap<PageSession, BackendNodeRefRegistry<PageRefEntry>>();

export function getPageRefRegistry(session: PageSession): BackendNodeRefRegistry<PageRefEntry> {
  let registry = registries.get(session);
  if (!registry) {
    registry = new BackendNodeRefRegistry<PageRefEntry>();
    registries.set(session, registry);
    const activeRegistry = registry;
    session.client.on('Page.frameNavigated', (params: any) => {
      if (!params.frame?.parentId) activeRegistry.clearDocument();
    });
  }
  return registry;
}

export function beginPageSnapshotRefs(
  session: PageSession,
): BackendNodeSnapshotRefAllocator<PageRefEntry> {
  return getPageRefRegistry(session).beginSnapshot();
}

export function resolvePageRef(session: PageSession, ref: string): PageRefEntry | undefined {
  return registries.get(session)?.resolve(ref);
}

export function deletePageRef(session: PageSession, ref: string): void {
  registries.get(session)?.delete(ref);
}

export function clearPageRefsForNavigation(session: PageSession): void {
  registries.get(session)?.clearDocument();
}

export async function enrichCdpPageChangeSetWithRefs(
  session: PageSession,
  observation: PageChangeSet,
): Promise<PageChangeSet> {
  return enrichPageChangeSetWithRefs(
    observation,
    getPageRefRegistry(session),
    selectors =>
      resolveUniqueBackendNodeIds(
        (method, params) => sendCdpDeviceShellPageCommand(session, method, params),
        selectors,
      ),
    (node, backendNodeId) => ({
      backendNodeId,
      role: node.role ?? '',
      name: node.name ?? '',
    }),
  );
}
