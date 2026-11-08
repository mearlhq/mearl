import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSkillInstalledListResult, AgentSkillProviderId } from '@mearl/browser-core';
import { SkillsManagerModal } from '../components/SkillsManagerModal';

const mocks = vi.hoisted(() => ({
  requestNativeHost: vi.fn(),
  searchCatalog: vi.fn(),
  resolveCatalog: vi.fn(),
}));

vi.mock('../nativeHostRequest', () => ({
  requestNativeHost: mocks.requestNativeHost,
}));

vi.mock('../skillCatalog', () => ({
  resolveSkillCatalog: mocks.resolveCatalog,
}));

vi.mock('../../panel/utils/i18n', () => ({
  t: (key: string, ...args: string[]) => {
    const messages: Record<string, string> = {
      agentSkillsBrowse: 'Browse',
      agentSkillsInstalled: 'Installed',
      agentSkillsCheckUpdates: 'Check updates',
      agentSkillsRefresh: 'Refresh',
      agentSkillsUpdateAvailable: 'Update available',
      agentSkillsUpdate: 'Update',
      agentSkillsUninstall: 'Uninstall',
      agentSkillsGlobal: 'Global',
      agentSkillsProject: 'Project',
      agentSkillsNoneInstalled: 'No installed skills',
      agentSkillsPreview: 'Preview',
      jsonViewModeCode: 'Code',
    };
    return messages[key] || [key, ...args].join(' ');
  },
}));

vi.mock('../../panel/components/modal/Modal', () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
  ModalHeader: ({ title, actions }: { title: ReactNode; actions: ReactNode }) => <div>{title}{actions}</div>,
  ModalContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function installedResult(name: string): AgentSkillInstalledListResult {
  return {
    skills: [{ name, path: `/skills/${name}/SKILL.md`, scope: 'global' }],
  };
}

function renderModal(providerId: AgentSkillProviderId) {
  return render(
    <SkillsManagerModal isOpen onClose={vi.fn()} providerId={providerId} cwd="/workspace" />,
  );
}


function catalog(revision = 'first', search = mocks.searchCatalog, markdown: (...args: any[]) => Promise<string> = vi.fn(async () => '# Skill')) {
  return { managerId: 'fixture-manager', title: 'Fixture Skills', homeUrl: 'https://skills.example.test/', revision, markdown, search };
}
const entry = { id: 'catalog-sample', name: 'catalog-sample', source: 'example/repo', sourceType: 'github', description: 'Catalog sample', installs: 12, tags: [], collectionIds: [], files: ['skills/sample/SKILL.md'], installSource: 'https://github.com/example/repo', pageUrl: 'https://skills.example.test/sample' };
function changePreset() {
  const listeners = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls;
  const listener = listeners.at(-1)![0];
  act(() => { listener({ action: 'browserRequestUiChanged' }, {}, vi.fn()); });
}
describe('SkillsManagerModal', () => {
  beforeEach(() => {
    mocks.requestNativeHost.mockReset();
    mocks.searchCatalog.mockReset().mockResolvedValue({ skills: [] });
    mocks.resolveCatalog.mockReset().mockResolvedValue(catalog());
  });

  it('uses the installed provider label and falls back to its ID', async () => {
    mocks.requestNativeHost.mockResolvedValue({ skills: [] });
    const { rerender } = render(<SkillsManagerModal isOpen onClose={vi.fn()} providerId="sample" providerLabel="Sample Agent" />);
    expect(screen.getByText('agentSkillsTitle Sample Agent')).toBeInTheDocument();
    rerender(<SkillsManagerModal isOpen onClose={vi.fn()} providerId="another" />);
    expect(screen.getByText('agentSkillsTitle another')).toBeInTheDocument();
    await waitFor(() => expect(mocks.requestNativeHost).toHaveBeenCalled());
  });

  it('ignores an installed-skills response from a previous provider', async () => {
    const codexResult = deferred<AgentSkillInstalledListResult>();
    const qoderResult = deferred<AgentSkillInstalledListResult>();
    mocks.requestNativeHost.mockImplementation(
      (action: string, data: { providerId?: AgentSkillProviderId }) => {
        if (action !== 'agent_skills_installed') throw new Error(`Unexpected action: ${action}`);
        return data.providerId === 'codex' ? codexResult.promise : qoderResult.promise;
      },
    );

    const { rerender } = renderModal('codex');
    await waitFor(() => expect(mocks.requestNativeHost).toHaveBeenCalledTimes(1));

    rerender(<SkillsManagerModal isOpen onClose={vi.fn()} providerId="qoder" cwd="/workspace" />);
    await waitFor(() => expect(mocks.requestNativeHost).toHaveBeenCalledTimes(2));

    await act(async () => qoderResult.resolve(installedResult('qoder-skill')));
    fireEvent.click(screen.getByRole('button', { name: /^Installed/ }));
    expect(await screen.findByText('qoder-skill')).toBeInTheDocument();

    await act(async () => codexResult.resolve(installedResult('codex-skill')));
    expect(screen.getByText('qoder-skill')).toBeInTheDocument();
    expect(screen.queryByText('codex-skill')).toBeNull();
  });

  it('clears an update marker after the update succeeds', async () => {
    mocks.requestNativeHost.mockImplementation((action: string) => {
      if (action === 'agent_skills_installed') {
        return Promise.resolve(installedResult('socket'));
      }
      if (action === 'agent_skills_check_updates') {
        return Promise.resolve({
          updates: [{ name: 'socket', scope: 'global' }],
        });
      }
      if (action === 'agent_skills_update') {
        return Promise.resolve({ ok: true, output: 'updated' });
      }
      throw new Error(`Unexpected action: ${action}`);
    });

    renderModal('codex');
    fireEvent.click(screen.getByRole('button', { name: /^Installed/ }));
    expect(await screen.findByText('socket')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check updates' }));
    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => {
      expect(mocks.requestNativeHost).toHaveBeenCalledWith(
        'agent_skills_update',
        expect.objectContaining({ providerId: 'codex', name: 'socket', scope: 'global' }),
      );
      expect(screen.queryByText('Update available')).toBeNull();
    });
  });

  it('moves skills with available updates ahead while preserving group order', async () => {
    mocks.requestNativeHost.mockImplementation((action: string) => {
      if (action === 'agent_skills_installed') {
        return Promise.resolve({
          skills: ['first', 'second', 'third', 'fourth'].map(name => ({
            name,
            path: `/skills/${name}/SKILL.md`,
            scope: 'global' as const,
          })),
        });
      }
      if (action === 'agent_skills_check_updates') {
        return Promise.resolve({
          updates: [
            { name: 'second', scope: 'global' },
            { name: 'fourth', scope: 'global' },
          ],
        });
      }
      throw new Error(`Unexpected action: ${action}`);
    });

    renderModal('codex');
    fireEvent.click(screen.getByRole('button', { name: /^Installed/ }));
    expect(await screen.findByTitle('first')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check updates' }));
    await waitFor(() => expect(screen.getAllByText('Update available')).toHaveLength(2));

    const orderedNames = ['first', 'second', 'third', 'fourth']
      .map(name => screen.getByTitle(name))
      .sort((left, right) => {
        const relation = left.compareDocumentPosition(right);
        return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .map(element => element.getAttribute('title'));
    expect(orderedNames).toEqual(['second', 'fourth', 'first', 'third']);
  });

  it('previews and syntax-highlights the local SKILL.md for an installed skill', async () => {
    mocks.requestNativeHost.mockImplementation((action: string) => {
      if (action === 'agent_skills_installed') {
        return Promise.resolve(installedResult('socket'));
      }
      if (action === 'agent_skills_read') {
        return Promise.resolve({
          path: '/skills/socket/SKILL.md',
          content: '# Socket skill\n\n```ts\nconst ready = true;\n```',
        });
      }
      throw new Error(`Unexpected action: ${action}`);
    });

    const { container } = renderModal('qoder');
    fireEvent.click(screen.getByRole('button', { name: /^Installed/ }));
    fireEvent.click(await screen.findByText('socket'));

    expect(await screen.findByRole('heading', { name: 'Socket skill' })).toBeInTheDocument();
    expect(container.querySelector('code.language-typescript .token.keyword')).toHaveTextContent(
      'const',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    await waitFor(() => {
      expect(container.querySelector('.token.title')).toHaveTextContent('# Socket skill');
    });
    expect(container.querySelector('.token.code')).toHaveTextContent('```ts');
    expect(mocks.requestNativeHost).toHaveBeenCalledWith('agent_skills_read', {
      providerId: 'qoder',
      path: '/skills/socket/SKILL.md',
      cwd: '/workspace',
    });
  });

it('installs with the selected manager assertion and explicit install source', async () => {
  mocks.searchCatalog.mockResolvedValue({ skills: [entry] });
  mocks.requestNativeHost.mockImplementation(async action => action === 'agent_skills_installed' ? { skills: [] } : { ok: true, output: 'installed' });
  renderModal('codex');
  fireEvent.click(await screen.findByRole('button', { name: 'agentSkillsInstall' }));
  await waitFor(() => expect(mocks.requestNativeHost).toHaveBeenCalledWith('agent_skills_install', { providerId: 'codex', name: entry.name, source: entry.installSource, expectedManagerId: 'fixture-manager', scope: 'project', cwd: '/workspace' }));
});
it('cancels an old search after a preset change and ignores its late result while keeping the query and scope', async () => {
  const late = deferred<{ skills: typeof entry[] }>();
  mocks.searchCatalog.mockImplementation(query => query ? late.promise : Promise.resolve({ skills: [] }));
  mocks.requestNativeHost.mockResolvedValue({ skills: [] });
  renderModal('codex');
  await waitFor(() => expect(mocks.searchCatalog).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText('agentSkillsSearchPlaceholder'), { target: { value: 'my query' } });
  await waitFor(() => expect(mocks.searchCatalog).toHaveBeenCalledWith('my query', expect.any(AbortSignal)));
  const oldSignal = mocks.searchCatalog.mock.calls.at(-1)![1];
  const nextSearch = vi.fn(async () => ({ skills: [{ ...entry, name: 'new-result' }] }));
  mocks.resolveCatalog.mockResolvedValue(catalog('second', nextSearch));
  changePreset();
  expect(await screen.findByText('new-result')).toBeInTheDocument();
  expect(oldSignal.aborted).toBe(true);
  await act(async () => late.resolve({ skills: [{ ...entry, name: 'old-result' }] }));
  expect(screen.queryByText('old-result')).toBeNull();
  expect(screen.getByPlaceholderText('agentSkillsSearchPlaceholder')).toHaveValue('my query');
  expect(screen.getByRole('combobox')).toHaveValue('project');
});
it('cancels an old preview and returns to the catalog without sending its detail to the next provider', async () => {
  const late = deferred<string>();
  const markdown = vi.fn((_skill: unknown, _signal?: AbortSignal) => late.promise);
  mocks.searchCatalog.mockResolvedValue({ skills: [entry] });
  mocks.resolveCatalog.mockResolvedValue(catalog('first', mocks.searchCatalog, markdown));
  mocks.requestNativeHost.mockResolvedValue({ skills: [] });
  renderModal('codex'); fireEvent.click(await screen.findByText(entry.name));
  await waitFor(() => expect(markdown).toHaveBeenCalled());
  const oldSignal = markdown.mock.calls[0][1]!;
  const nextMarkdown = vi.fn(async () => '# New provider');
  mocks.resolveCatalog.mockResolvedValue(catalog('second', vi.fn(async () => ({ skills: [] })), nextMarkdown));
  changePreset();
  await waitFor(() => expect(oldSignal.aborted).toBe(true));
  await act(async () => late.resolve('# Old preview'));
  expect(screen.queryByRole('heading', { name: 'Old preview' })).toBeNull();
  expect(nextMarkdown).not.toHaveBeenCalled();
  expect(screen.getByPlaceholderText('agentSkillsSearchPlaceholder')).toBeInTheDocument();
});
it('retains a manager-conflict error and search text without retrying installation through the new manager', async () => {
  mocks.searchCatalog.mockResolvedValue({ skills: [entry] });
  mocks.requestNativeHost.mockImplementation(async action => {
    if (action === 'agent_skills_installed') return { skills: [] };
    if (action === 'agent_skills_install') throw new Error('SKILL_MANAGER_CHANGED');
  });
  renderModal('codex');
  fireEvent.change(screen.getByPlaceholderText('agentSkillsSearchPlaceholder'), { target: { value: 'sample' } });
  fireEvent.click(await screen.findByRole('button', { name: 'agentSkillsInstall' }));
  expect(await screen.findByText('agentSkillsManagerChanged')).toBeInTheDocument();
  await waitFor(() => expect(mocks.resolveCatalog).toHaveBeenCalledTimes(2));
  expect(screen.getByPlaceholderText('agentSkillsSearchPlaceholder')).toHaveValue('sample');
  expect(mocks.requestNativeHost.mock.calls.filter(([action]) => action === 'agent_skills_install')).toHaveLength(1);
});
it('keeps an installed detail and its local preview across catalog changes', async () => {
  mocks.requestNativeHost.mockImplementation(async action => action === 'agent_skills_read' ? { content: '# Local preview' } : installedResult('local-skill'));
  renderModal('codex');
  fireEvent.click(screen.getByRole('button', { name: /^Installed/ }));
  fireEvent.click(await screen.findByText('local-skill'));
  expect(await screen.findByRole('heading', { name: 'Local preview' })).toBeInTheDocument();
  mocks.resolveCatalog.mockResolvedValue(catalog('second'));
  changePreset();
  await waitFor(() => expect(mocks.resolveCatalog).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('heading', { name: 'Local preview' })).toBeInTheDocument();
  expect(mocks.requestNativeHost.mock.calls.filter(([action]) => action === 'agent_skills_read')).toHaveLength(1);
});

it('prepares catalog metadata while closed without flashing a public catalog title', async () => {
  const pending = deferred<ReturnType<typeof catalog>>();
  mocks.resolveCatalog.mockReset().mockReturnValue(pending.promise);
  const { rerender } = render(<SkillsManagerModal isOpen={false} onClose={vi.fn()} providerId="codex" />);
  await waitFor(() => expect(mocks.resolveCatalog).toHaveBeenCalledOnce());
  expect(mocks.searchCatalog).not.toHaveBeenCalled();
  rerender(<SkillsManagerModal isOpen onClose={vi.fn()} providerId="codex" />);
  expect(screen.queryByRole('link')).toBeNull();
  await act(async () => pending.resolve(catalog()));
  expect(screen.getByRole('link', { name: 'Fixture Skills' })).toBeInTheDocument();
});

});
