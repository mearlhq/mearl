import type { ResolvedEmulationConfig } from '@mearl/browser-core';

const tabEmulationConfigs = new Map<number, ResolvedEmulationConfig>();
const tabFitToWindowStates = new Set<number>();

export function setEmulationConfigForTab(tabId: number, config: ResolvedEmulationConfig): void {
  tabEmulationConfigs.set(tabId, config);
}

export function getEmulationConfigForTab(tabId: number): ResolvedEmulationConfig | undefined {
  return tabEmulationConfigs.get(tabId);
}

export function clearEmulationConfigForTab(tabId: number): void {
  tabEmulationConfigs.delete(tabId);
  tabFitToWindowStates.delete(tabId);
}

export function setEmulationFitToWindowForTab(tabId: number, enabled: boolean): void {
  if (enabled && tabEmulationConfigs.has(tabId)) {
    tabFitToWindowStates.add(tabId);
    return;
  }
  tabFitToWindowStates.delete(tabId);
}

export function getEmulationFitToWindowForTab(tabId: number): boolean {
  return tabEmulationConfigs.has(tabId) && tabFitToWindowStates.has(tabId);
}
