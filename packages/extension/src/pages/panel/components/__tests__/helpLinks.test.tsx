// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const mocks = vi.hoisted(() => ({ settings: {} as any }));
vi.mock('../../utils/browserUiSettings', () => ({
  useBrowserUiSettings: () => mocks.settings,
  useSetupManagement: () => mocks.settings.setup,
}));
vi.mock('../../utils/i18n', () => ({
  t: (key: string, value?: string) => (value ? `${key}: ${value}` : key),
}));
vi.mock('../../utils/config', () => ({
  getConfig: async () => ({}),
  updateConfig: async () => {},
}));
vi.mock('../../hooks/useCloudConnectorStatus', () => ({
  useCloudConnectorStatus: () => ({ state: { connected: false }, loading: false }),
}));
vi.mock('../modal/Modal', () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
  ModalHeader: ({ title, actions }: { title: ReactNode; actions: ReactNode }) => (
    <header>
      {title}
      {actions}
    </header>
  ),
  ModalContent: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  ModalFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}));
import { SettingsModal } from '../SettingsModal';
import { AgentStatusModal } from '../AgentStatusModal';
beforeEach(() => {
  mocks.settings = {};
  localStorage.clear();
  chrome.runtime.getURL = vi.fn(() => 'about:blank');
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true });
});
it.each([undefined, 'https://docs.example.test/manual'])(
  'keeps the settings manual link and permits an installed destination %s',
  manual => {
    mocks.settings = { links: { manual } };
    render(<SettingsModal onClose={() => {}} />);
    expect(screen.getByRole('link', { name: 'userManual' })).toHaveAttribute(
      'href',
      manual ?? 'https://mearlhq.github.io/mearl/',
    );
  },
);
it.each([undefined, 'https://docs.example.test/agent'])(
  'keeps agent setup controls with public Skills and an installed guide %s',
  guide => {
    mocks.settings = { links: { agentDocs: guide, skillSetup: guide } };
    render(<AgentStatusModal isOpen agentConnected={false} onClose={() => {}} />);
    expect(screen.getByRole('link', { name: 'agentFullDocs' })).toHaveAttribute(
      'href',
      guide ?? 'https://github.com/mearlhq/mearl',
    );
    expect(screen.getByText('npx @mearl/setup')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'skillSetupAgent' }));
    expect(
      screen.getByText(`skillSetupAgentPrompt: ${guide ?? 'https://github.com/mearlhq/mearl'}`),
    ).toBeInTheDocument();
  },
);

it('uses the preset registry for both setup display and copy', async () => {
  mocks.settings = {
    setup: {
      package: '@example/setup',
      version: 'latest',
      registry: 'https://registry.example.test/',
    },
  };
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<AgentStatusModal isOpen agentConnected={false} onClose={() => {}} />);
  const command = 'npx --registry=https://registry.example.test/ @example/setup@latest';
  const code = screen.getByText(command);
  expect(code).toBeInTheDocument();
  fireEvent.click(code.parentElement!.querySelector('button')!);
  expect(writeText).toHaveBeenCalledWith(command);
});
