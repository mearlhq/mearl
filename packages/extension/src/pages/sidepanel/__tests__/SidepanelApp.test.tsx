import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidepanelApp } from '../SidepanelApp';

const configMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  onConfigChange: vi.fn(),
}));

vi.mock('../../panel/utils/config', () => configMocks);
vi.mock('../../popup/Popup', () => ({
  Popup: ({ isSidePanel }: { isSidePanel?: boolean }) => (
    <div data-testid="popup">{String(isSidePanel)}</div>
  ),
}));
vi.mock('../SidepanelChat', () => ({
  SidepanelChat: ({ windowId }: { windowId: number | null }) => (
    <div data-testid="agent-chat">{windowId}</div>
  ),
}));

describe('SidepanelApp', () => {
  let notifyConfigChange: ((changes: { agentEnabled?: boolean }) => void) | undefined;

  beforeEach(() => {
    notifyConfigChange = undefined;
    configMocks.getConfig.mockReset();
    configMocks.onConfigChange.mockReset().mockImplementation(callback => {
      notifyConfigChange = callback;
      return vi.fn();
    });
  });

  it('shows the original popup content when Agent service is disabled', async () => {
    configMocks.getConfig.mockResolvedValue({ agentEnabled: false });
    render(<SidepanelApp windowId={7} />);

    expect(await screen.findByTestId('popup')).toHaveTextContent('true');
    expect(screen.queryByTestId('agent-chat')).toBeNull();
  });

  it('switches between Agent chat and popup content when the setting changes', async () => {
    configMocks.getConfig.mockResolvedValue({ agentEnabled: true });
    render(<SidepanelApp windowId={7} />);

    expect(await screen.findByTestId('agent-chat')).toHaveTextContent('7');
    act(() => notifyConfigChange?.({ agentEnabled: false }));
    expect(screen.getByTestId('popup')).toHaveTextContent('true');
    expect(screen.queryByTestId('agent-chat')).toBeNull();

    act(() => notifyConfigChange?.({ agentEnabled: true }));
    expect(screen.getByTestId('agent-chat')).toHaveTextContent('7');
  });

  it('keeps a newer setting change when the initial config read finishes later', async () => {
    let resolveConfig: ((config: { agentEnabled: boolean }) => void) | undefined;
    configMocks.getConfig.mockReturnValue(
      new Promise(resolve => {
        resolveConfig = resolve;
      }),
    );
    render(<SidepanelApp windowId={7} />);

    act(() => notifyConfigChange?.({ agentEnabled: false }));
    expect(screen.getByTestId('popup')).toBeInTheDocument();
    await act(async () => resolveConfig?.({ agentEnabled: true }));
    expect(screen.getByTestId('popup')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-chat')).toBeNull();
  });
});
