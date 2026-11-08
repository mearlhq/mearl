import type { BackendNodeRefEntry, BackendNodeRefRegistry } from './backendNodeRefs.js';
import type { PageChangeSet, PageEffectNode } from './pageObserver.js';

export interface PageEffectRefEntry extends BackendNodeRefEntry {
  role: string;
  name: string;
}

export type CdpCommandSender = (method: string, params?: Record<string, unknown>) => Promise<any>;

let nextObjectGroupId = 0;

/**
 * Resolves a bounded list of selectors without walking the full DOM or AX tree.
 * Selectors that are invalid, missing, or no longer unique are omitted so a
 * delayed enrichment step can never silently bind a ref to the wrong element.
 */
export async function resolveUniqueBackendNodeIds(
  sendCommand: CdpCommandSender,
  selectors: readonly string[],
): Promise<Map<string, number>> {
  if (selectors.length === 0) return new Map();

  nextObjectGroupId += 1;
  const objectGroup = `mearl-page-effect-refs-${nextObjectGroupId}`;
  const expression = `(${function resolveUniqueElements(values: string[]): Array<Element | null> {
    return values.map(selector => {
      try {
        const matches = document.querySelectorAll(selector);
        return matches.length === 1 ? matches[0] : null;
      } catch {
        return null;
      }
    });
  }.toString()})(${JSON.stringify(selectors)})`;

  try {
    const evaluated = await sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: false,
      objectGroup,
    });
    if (evaluated.exceptionDetails) return new Map();
    const arrayObjectId = evaluated.result?.objectId;
    if (!arrayObjectId) return new Map();

    const properties = await sendCommand('Runtime.getProperties', {
      objectId: arrayObjectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: false,
    });
    const valuesByIndex = new Map<number, string>();
    for (const property of properties.result ?? []) {
      const index = Number(property.name);
      const objectId = property.value?.objectId;
      if (!Number.isInteger(index) || index < 0 || !objectId) continue;
      valuesByIndex.set(index, objectId);
    }

    const resolvedPairs = await Promise.all(
      selectors.map(async (selector, index) => {
        const objectId = valuesByIndex.get(index);
        if (!objectId) return null;
        try {
          const described = await sendCommand('DOM.describeNode', { objectId });
          const backendNodeId = described.node?.backendNodeId;
          return typeof backendNodeId === 'number' ? ([selector, backendNodeId] as const) : null;
        } catch {
          return null;
        }
      }),
    );

    return new Map(resolvedPairs.filter(pair => pair !== null));
  } finally {
    await sendCommand('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
}

/**
 * Adds real backend-node refs to actionable delta nodes while preserving the
 * compact observation shape. Ref resolution is handled by the caller so the
 * same logic works for the extension and native CDP transports.
 */
export async function enrichPageChangeSetWithRefs<T extends PageEffectRefEntry>(
  observation: PageChangeSet,
  registry: BackendNodeRefRegistry<T>,
  resolveBackendNodeIds: (selectors: readonly string[]) => Promise<ReadonlyMap<string, number>>,
  createEntry: (node: PageEffectNode, backendNodeId: number) => T,
): Promise<PageChangeSet> {
  const candidates = [
    ...observation.effects.interactives.map(effect => effect.node),
    ...(observation.effects.focus ? [observation.effects.focus] : []),
  ];
  const selectors = Array.from(
    new Set(candidates.filter(node => !node.ref).map(node => node.selector)),
  );
  if (selectors.length === 0) return observation;

  const deltaRefs = registry.beginDelta();
  const backendNodeIds = await resolveBackendNodeIds(selectors);
  if (backendNodeIds.size === 0) return observation;

  const enrichNode = (node: PageEffectNode): PageEffectNode => {
    if (node.ref) return node;
    const backendNodeId = backendNodeIds.get(node.selector);
    if (backendNodeId === undefined) return node;
    return {
      ...node,
      ref: deltaRefs.register(createEntry(node, backendNodeId)),
    };
  };

  return {
    ...observation,
    effects: {
      ...observation.effects,
      interactives: observation.effects.interactives.map(effect => ({
        ...effect,
        node: enrichNode(effect.node),
      })),
      ...(observation.effects.focus ? { focus: enrichNode(observation.effects.focus) } : {}),
    },
  };
}
