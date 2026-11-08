import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Installation } from '../Installation';
import { setupPresetCommand, type InstallationView } from '../../../shared/installation';
vi.mock('../../panel/utils/i18n', () => ({ t: (key: string) => key }));
let state: InstallationView;
let send: ReturnType<typeof vi.fn>;
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  state = {
    session: 'test',
    presetId: 'team',
    label: 'Team',
    source: 'https://example.test/team.json',
    origins: ['https://example.test/*'],
    missingOrigins: [],
    missingAuthorization: [],
    browserReady: false,
    needsInstall: true,
    localComponentCount: 1,
  };
  send = vi.fn(async input => ({
    success: true,
    data:
      input.operation === 'inspect'
        ? structuredClone(state)
        : { ...state, browserReady: true, needsInstall: false },
  }));
  chrome.runtime.sendMessage = send as any;
  chrome.permissions = { request: vi.fn(async () => true) } as any;
});
it('restarts an expired automatic view and navigates to its fresh session', async () => {
  const replace = vi.fn();
  vi.stubGlobal('location', {
    href: 'chrome-extension://installed-extension/src/pages/installation/index.html?session=expired',
    search: '?session=expired',
    replace,
  });
  send.mockImplementation(async input =>
    input.operation === 'inspect'
      ? { success: false, error: 'INSTALLATION_SESSION_EXPIRED' }
      : { success: true, data: { session: 'renewed' } },
  );
  render(<Installation />);
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith(
      'chrome-extension://installed-extension/src/pages/installation/index.html?session=renewed',
    ),
  );
  expect(send.mock.calls.map(([message]) => message.operation)).toEqual(['inspect', 'restart']);
  expect(chrome.permissions.request).not.toHaveBeenCalled();
});
it('lets users retry or close an expired website confirmation without restarting it', async () => {
  vi.stubGlobal('location', {
    href: 'chrome-extension://installed-extension/src/pages/installation/index.html?session=expired&source=website',
    search: '?session=expired&source=website',
  });
  send.mockResolvedValue({ success: false, error: 'INSTALLATION_SESSION_EXPIRED' });
  render(<Installation />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByText('presetInstallRefresh'));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  const getCurrent = vi.fn(async () => ({ id: 42 }));
  const remove = vi.fn(async () => {});
  vi.stubGlobal('chrome', { ...chrome, tabs: { getCurrent, remove } });
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(42));
  expect(send.mock.calls.map(([message]) => message.operation)).toEqual(['inspect', 'inspect']);
});
it('applies an already authorized selection automatically and refreshes a completed view without installing again', async () => {
  render(<Installation />);
  await screen.findByText('presetInstallBrowserReady');
  expect(send.mock.calls.map(([m]) => m.operation)).toEqual(['inspect', 'install']);
  state = { ...state, needsInstall: false, browserReady: false, presetId: 'other' };
  fireEvent.click(screen.getByText('presetInstallRefresh'));
  await screen.findByRole('alert');
  expect(send.mock.calls.filter(([m]) => m.operation === 'install')).toHaveLength(1);
  expect(screen.getByRole('alert')).toHaveTextContent('presetInstallSessionExpired');
});
it('requests missing Chrome scopes directly during the click and retains permission denial for retry', async () => {
  state.missingOrigins = ['https://example.test/*'];
  state.missingAuthorization = state.origins;
  render(<Installation />);
  const button = await screen.findByText('presetInstallAllow');
  let clicking = false;
  chrome.permissions.request = vi.fn(() => {
    expect(clicking).toBe(true);
    return Promise.resolve(false);
  }) as any;
  clicking = true;
  fireEvent.click(button);
  clicking = false;
  await screen.findByRole('alert');
  expect(screen.getByText('presetInstallAllow')).toBeInTheDocument();
  expect(send).toHaveBeenCalledTimes(1);
  chrome.permissions.request = vi.fn(async () => true) as any;
  fireEvent.click(screen.getByText('presetInstallAllow'));
  await screen.findByText('presetInstallBrowserReady');
  expect(send.mock.calls.at(-1)![0]).toMatchObject({ operation: 'install', authorize: true });
});
it('authorizes only Agent scopes without opening an unnecessary Chrome prompt', async () => {
  state.missingAuthorization = state.origins;
  render(<Installation />);
  fireEvent.click(await screen.findByText('presetInstallAllow'));
  await screen.findByText('presetInstallBrowserReady');
  expect(chrome.permissions.request).not.toHaveBeenCalled();
});
it('waits for source approval before reading and a second confirmation before installing with existing grants', async () => {
  state = {
    ...state,
    sourceRequest: {
      catalogUrl: 'https://example.test/catalog.json',
      requestingPage: 'https://example.test/installed.html',
    },
    needsSourceConfirmation: true,
  };
  send.mockImplementation(async input => {
    if (input.operation === 'confirmSource') state = { ...state, needsSourceConfirmation: false };
    return {
      success: true,
      data:
        input.operation === 'install'
          ? { ...state, browserReady: true, needsInstall: false }
          : structuredClone(state),
    };
  });
  render(<Installation />);
  fireEvent.click(await screen.findByText('presetInstallReadSource'));
  const confirm = await screen.findByText('presetInstallConfirmOnce');
  expect(send.mock.calls.map(([message]) => message.operation)).toEqual([
    'inspect',
    'confirmSource',
  ]);
  expect(screen.getByText(state.sourceRequest!.catalogUrl)).toBeInTheDocument();
  expect(screen.getByText(state.source)).toBeInTheDocument();
  expect(chrome.permissions.request).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await screen.findByText('presetInstallBrowserReady');
  expect(send.mock.calls.at(-1)![0]).toMatchObject({ operation: 'install', authorize: true });
});
it('retains source confirmation after a denied site permission without reading the catalog', async () => {
  state = {
    ...state,
    sourceRequest: {
      catalogUrl: 'https://example.test/catalog.json',
      requestingPage: 'https://example.test/installed.html',
    },
    needsSourceConfirmation: true,
    missingOrigins: state.origins,
  };
  chrome.permissions.request = vi.fn(async () => false) as any;
  render(<Installation />);
  fireEvent.click(await screen.findByText('presetInstallReadSource'));
  await screen.findByRole('alert');
  expect(screen.getByText('presetInstallReadSource')).toBeInTheDocument();
  expect(send.mock.calls.map(([message]) => message.operation)).toEqual(['inspect']);
});
it('does not automatically install an accepted website source after refreshing its view', async () => {
  state.sourceRequest = {
    catalogUrl: 'https://example.test/catalog.json',
    requestingPage: 'https://example.test/installed.html',
  };
  render(<Installation />);
  await screen.findByText('presetInstallConfirmOnce');
  expect(send.mock.calls.map(([message]) => message.operation)).toEqual(['inspect']);
});
it.each([
  [
    'BUNDLE_INTEGRITY: Installed preset receipt does not match its selection',
    'presetInstallIntegrityFailed',
  ],
  ['BUNDLE_INVALID: Invalid app profile: actions', 'presetInstallConfigurationFailed'],
  ['PRESET_INVALID: packages.app.targets: invalid value', 'presetInstallConfigurationFailed'],
  ['BUNDLE_INCOMPATIBLE: Unsupported Mearl API version', 'presetInstallConfigurationFailed'],
  ['PRESET_INCOMPATIBLE: Unsupported Mearl API version', 'presetInstallConfigurationFailed'],
  ['Failed to fetch', 'presetInstallFailed'],
])('retains source approval with a classified failure: %s', async (error, message) => {
  state = {
    ...state,
    sourceRequest: {
      catalogUrl: 'https://example.test/catalog.json',
      requestingPage: 'https://example.test/installed.html',
    },
    needsSourceConfirmation: true,
  };
  send.mockImplementation(async input =>
    input.operation === 'confirmSource'
      ? { success: false, error }
      : { success: true, data: structuredClone(state) },
  );
  render(<Installation />);
  fireEvent.click(await screen.findByText('presetInstallReadSource'));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByText('presetInstallReadSource')).toBeInTheDocument();
  expect(send.mock.calls.map(([input]) => input.operation)).toEqual(['inspect', 'confirmSource']);
});
it('keeps Native-linked updates actionable with the single setup command', async () => {
  send.mockImplementation(async input =>
    input.operation === 'install'
      ? { success: false, error: 'INSTALLATION_NATIVE_SYNC_REQUIRED' }
      : { success: true, data: state },
  );
  render(<Installation />);
  await screen.findByText('presetInstallNativeSync');
  expect(
    screen.getByText(setupPresetCommand(state.source, /Win/.test(navigator.platform))),
  ).toBeInTheDocument();
});
it('does not update an unmounted view after a permission decision', async () => {
  state.missingOrigins = state.origins;
  let finish!: (value: boolean) => void;
  chrome.permissions.request = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  ) as any;
  const page = render(<Installation />);
  fireEvent.click(await screen.findByText('presetInstallAllow'));
  page.unmount();
  await act(async () => finish(true));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
});
it('quotes preset sources as a single shell argument on POSIX and PowerShell', () => {
  expect(setupPresetCommand("https://example.test/it's.json")).toBe(
    "npx @mearl/setup --preset 'https://example.test/it'\\''s.json'",
  );
  expect(setupPresetCommand("https://example.test/it's.json", true)).toBe(
    "npx @mearl/setup --preset 'https://example.test/it''s.json'",
  );
});

it('reports Native-only readiness while leaving an independent browser selection alone', async () => {
  state = {
    ...state,
    needsInstall: false,
    ready: true,
    browserReady: false,
    browserRequired: false,
    localStatus: 'ready',
  };
  render(<Installation />);
  await screen.findByText('presetInstallAllReady');
  expect(send.mock.calls.map(([m]) => m.operation)).toEqual(['inspect']);
  expect(screen.queryByText('presetInstallSetupHint')).not.toBeInTheDocument();
});
it('offers an explicit pending retry while keeping status refresh read-only', async () => {
  state = {
    ...state,
    needsInstall: false,
    browserReady: true,
    ready: false,
    localStatus: 'pending',
  };
  send.mockImplementation(async input => ({
    success: true,
    data: input.operation === 'retry' ? { ...state, ready: true, localStatus: 'ready' } : state,
  }));
  render(<Installation />);
  await screen.findByText('presetInstallLocalRetry');
  fireEvent.click(screen.getByText('presetInstallRefresh'));
  await screen.findByText('presetInstallLocalRetry');
  expect(send.mock.calls.map(([m]) => m.operation)).toEqual(['inspect', 'inspect']);
  fireEvent.click(screen.getByText('presetInstallLocalRetry'));
  await screen.findByText('presetInstallAllReady');
  expect(send.mock.calls.at(-1)![0]).toMatchObject({ operation: 'retry' });
});

it('shows actionable Native-only pending state without claiming browser activation', async () => {
  state = {
    ...state,
    needsInstall: false,
    ready: false,
    browserReady: false,
    browserRequired: false,
    localStatus: 'pending',
  };
  render(<Installation />);
  await screen.findByText('presetInstallLocalRetry');
  expect(screen.getByText('presetInstallLocalPendingTitle')).toBeInTheDocument();
  expect(screen.queryByText('presetInstallBrowserReady')).not.toBeInTheDocument();
});
it('shows missing components and source conflicts with an explanation of the paused batch', async () => {
  state = {
    ...state,
    needsInstall: false,
    browserReady: true,
    ready: false,
    localStatus: 'pending',
    localIssues: [
      { id: 'missing-skill', reason: 'SKILL_NOT_INSTALLED' },
      { id: 'existing-skill', reason: 'SKILL_SOURCE_CONFLICT' },
    ],
  };
  render(<Installation />);
  await screen.findByText('presetInstallPendingItems');
  expect(screen.getByText('missing-skill')).toBeInTheDocument();
  expect(screen.getByText('existing-skill')).toBeInTheDocument();
  expect(screen.getByText('presetInstallConflictHint')).toBeInTheDocument();
});
it('lists source replacements for confirmation and only sends the listed conflicts after an explicit approval', async () => {
  state = {
    ...state,
    needsInstall: false,
    browserReady: true,
    ready: false,
    localStatus: 'pending',
    localIssues: [
      { id: 'missing', reason: 'SKILL_NOT_INSTALLED' },
      { id: 'sample-auth', reason: 'SKILL_SOURCE_CONFLICT' },
      { id: 'mearl', reason: 'SKILL_SOURCE_CONFLICT' },
    ],
  };
  send.mockImplementation(async () => ({ success: true, data: structuredClone(state) }));
  render(<Installation />);
  fireEvent.click(await screen.findByText('presetInstallReplaceSources'));
  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toHaveTextContent('sample-auth');
  expect(dialog).toHaveTextContent('mearl');
  expect(dialog).not.toHaveTextContent('missing');
  expect(send.mock.calls.map(([message]) => message.operation)).toEqual(['inspect']);
  fireEvent.click(screen.getByText('presetInstallCancel'));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(send).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('presetInstallReplaceSources'));
  fireEvent.click(screen.getByText('presetInstallReplaceConfirm'));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls.at(-1)![0]).toMatchObject({
    operation: 'retry',
    authorize: true,
    replaceSkills: ['sample-auth', 'mearl'],
  });
});
it('distinguishes incomplete registrations and includes them in explicit repair confirmation', async () => {
  state = {
    ...state,
    needsInstall: false,
    browserReady: true,
    ready: false,
    localStatus: 'pending',
    localIssues: [
      { id: 'sample-request', reason: 'SKILL_PLUGIN_REGISTRATION_CONFLICT' },
      { id: 'sample-auth', reason: 'SKILL_PLUGIN_REGISTRATION_REQUIRED' },
    ],
  };
  send.mockImplementation(async () => ({ success: true, data: structuredClone(state) }));
  render(<Installation />);
  await screen.findByText(/presetInstallComponentRegistrationConflict/);
  expect(screen.getByText(/presetInstallComponentRegistrationPending/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('presetInstallReplaceSources'));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('sample-request');
  expect(screen.getByRole('alertdialog')).toHaveTextContent('sample-auth');
  fireEvent.click(screen.getByText('presetInstallReplaceConfirm'));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls.at(-1)![0]).toMatchObject({
    operation: 'retry',
    authorize: true,
    replaceSkills: ['sample-request', 'sample-auth'],
  });
});
