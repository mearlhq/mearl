import { beforeEach, describe, expect, it, vi } from 'vitest';
import manifest from '../../../manifest';
import {
  TOGGLE_AGENT_SIDE_PANEL_ALTERNATE_COMMAND,
  TOGGLE_AGENT_SIDE_PANEL_COMMAND,
  agentSidePanelShortcutLabel,
  isToggleAgentSidePanelCommand,
  toggleAgentSidePanel,
} from '../agentSidePanelState';

type SidePanelWithClose = typeof chrome.sidePanel & {
  close: (options: { windowId: number }) => Promise<void>;
};

describe('agentSidePanelState', () => {
  beforeEach(() => {
    chrome.sidePanel = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;
  });

  it('opens a closed Agent side panel', async () => {
    const operation = toggleAgentSidePanel(7, false);

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
    expect((chrome.sidePanel as SidePanelWithClose).close).not.toHaveBeenCalled();
    await operation;
  });

  it('closes an open Agent side panel', async () => {
    const operation = toggleAgentSidePanel(7, true);

    expect((chrome.sidePanel as SidePanelWithClose).close).toHaveBeenCalledWith({ windowId: 7 });
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
    await operation;
  });

  it('opens the side panel when Chrome only provides the open API', async () => {
    delete (chrome.sidePanel as Partial<SidePanelWithClose>).close;

    await toggleAgentSidePanel(7, false);
    expect(toggleAgentSidePanel(7, true)).toBeUndefined();
    expect(chrome.sidePanel.open).toHaveBeenCalledExactlyOnceWith({ windowId: 7 });
  });

  it('uses Control and Alt shortcuts supported by Chrome', () => {
    expect(TOGGLE_AGENT_SIDE_PANEL_COMMAND).toBe('open-agent-side-panel');
    expect(TOGGLE_AGENT_SIDE_PANEL_ALTERNATE_COMMAND).toBe('open-agent-side-panel-alternate');
    expect(manifest).toMatchObject({
      commands: {
        [TOGGLE_AGENT_SIDE_PANEL_COMMAND]: {
          suggested_key: { default: 'Ctrl+Shift+M', mac: 'MacCtrl+Shift+M' },
        },
        [TOGGLE_AGENT_SIDE_PANEL_ALTERNATE_COMMAND]: {
          suggested_key: { default: 'Alt+Shift+M' },
        },
      },
    });
    const serializedManifest = JSON.stringify(manifest);
    expect(serializedManifest).not.toContain('"mac":"Alt+Shift+M"');
    expect(serializedManifest).not.toContain('Command+');
    expect(serializedManifest).not.toContain('Option+');
    expect(isToggleAgentSidePanelCommand(TOGGLE_AGENT_SIDE_PANEL_COMMAND)).toBe(true);
    expect(isToggleAgentSidePanelCommand(TOGGLE_AGENT_SIDE_PANEL_ALTERNATE_COMMAND)).toBe(true);
    expect(isToggleAgentSidePanelCommand('unrelated')).toBe(false);
    expect(agentSidePanelShortcutLabel('MacIntel')).toBe('⌃/⌥+⇧+M');
    expect(agentSidePanelShortcutLabel('Win32')).toBe('Ctrl/Alt+Shift+M');
  });
});
