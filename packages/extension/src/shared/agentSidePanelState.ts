export const AGENT_SIDE_PANEL_PRESENCE_PORT = 'agent-side-panel-presence-v1';
export const TOGGLE_AGENT_SIDE_PANEL_COMMAND = 'open-agent-side-panel';
export const TOGGLE_AGENT_SIDE_PANEL_ALTERNATE_COMMAND = 'open-agent-side-panel-alternate';
export const GET_AGENT_SIDE_PANEL_STATE_ACTION = 'getAgentSidePanelState';
export const OPEN_AGENT_SIDE_PANEL_FROM_PAGE_ACTION = 'openAgentSidePanelFromPage';
export const AGENT_SIDE_PANEL_STATE_CHANGED_ACTION = 'agentSidePanelStateChanged';

const AGENT_SIDE_PANEL_STATE_PREFIX = 'agentSidePanelOpenWindowV1:';

export function isToggleAgentSidePanelCommand(command: string): boolean {
  return (
    command === TOGGLE_AGENT_SIDE_PANEL_COMMAND ||
    command === TOGGLE_AGENT_SIDE_PANEL_ALTERNATE_COMMAND
  );
}

export function agentSidePanelShortcutLabel(platform: string): string {
  return /mac/i.test(platform) ? '⌃/⌥+⇧+M' : 'Ctrl/Alt+Shift+M';
}

export function agentSidePanelStateKey(windowId: number): string {
  return `${AGENT_SIDE_PANEL_STATE_PREFIX}${windowId}`;
}

export async function readAgentSidePanelState(windowId: number): Promise<boolean> {
  const key = agentSidePanelStateKey(windowId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] === true;
}

export async function writeAgentSidePanelState(windowId: number, open: boolean): Promise<void> {
  const key = agentSidePanelStateKey(windowId);
  if (open) {
    await chrome.storage.session.set({ [key]: true });
  } else {
    await chrome.storage.session.remove(key);
  }
}

type SidePanelWithClose = typeof chrome.sidePanel & {
  close?: (options: { windowId: number }) => Promise<void>;
};

export function toggleAgentSidePanel(windowId: number, open: boolean): Promise<void> | undefined {
  if (open) {
    return (chrome.sidePanel as SidePanelWithClose).close?.({ windowId });
  }
  return chrome.sidePanel.open({ windowId });
}
