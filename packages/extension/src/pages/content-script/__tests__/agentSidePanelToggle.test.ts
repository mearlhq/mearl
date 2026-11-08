import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_SIDE_PANEL_TOGGLE_ATTRIBUTE,
  createAgentSidePanelToggle,
  isAgentSidePanelToggleElement,
  shouldShowAgentFloatingButton,
} from '../agentSidePanelToggle';

const label = 'Open Protocol side panel';

const activeToggles: Array<ReturnType<typeof createAgentSidePanelToggle>> = [];

const createToggle = (onOpen: () => Promise<void> = vi.fn()) => {
  const toggle = createAgentSidePanelToggle({ label, onOpen });
  activeToggles.push(toggle);
  return toggle;
};

const findToggle = () => {
  const host = document.querySelector<HTMLElement>(`[${AGENT_SIDE_PANEL_TOGGLE_ATTRIBUTE}]`)!;
  const button = host.shadowRoot!.querySelector<HTMLButtonElement>('button')!;
  return { host, button };
};

afterEach(() => {
  activeToggles.splice(0).forEach(toggle => toggle.destroy());
  document
    .querySelectorAll(`[${AGENT_SIDE_PANEL_TOGGLE_ATTRIBUTE}]`)
    .forEach(node => node.remove());
});

describe('agentSidePanelToggle', () => {
  it('shows only when enabled and the side panel is closed', () => {
    expect(shouldShowAgentFloatingButton(true, true, false)).toBe(true);
    expect(shouldShowAgentFloatingButton(true, true, true)).toBe(false);
    expect(shouldShowAgentFloatingButton(true, true, null)).toBe(false);
    expect(shouldShowAgentFloatingButton(true, false, false)).toBe(false);
    expect(shouldShowAgentFloatingButton(false, true, false)).toBe(false);
  });

  it('renders an isolated accessible button and cleans it up', () => {
    const toggle = createToggle();
    const { host, button } = findToggle();

    expect(host.getAttribute('popover')).toBe('manual');
    expect(host.shadowRoot).not.toBeNull();
    expect(button.title).toBe(label);
    expect(button.getAttribute('aria-label')).toBe(label);
    expect(button).not.toHaveAttribute('aria-pressed');
    expect(button).not.toHaveAttribute('data-open');
    expect(isAgentSidePanelToggleElement(host)).toBe(true);

    toggle.destroy();
    expect(host.isConnected).toBe(false);
  });

  it('restores the host when the page removes it', async () => {
    createToggle();
    const { host } = findToggle();

    host.remove();

    await vi.waitFor(() => expect(host.parentElement).toBe(document.documentElement));
  });

  it('opens through the provided user-action handler', async () => {
    let resolveOpen: (() => void) | undefined;
    const onOpen = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveOpen = resolve;
        }),
    );
    createToggle(onOpen);
    const { button } = findToggle();

    button.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);

    resolveOpen?.();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
  });
});
