import { ExtensionRpcError } from '@mearl/browser-core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserManager } from '../BrowserManager';

const managerMocks = vi.hoisted(() => ({
  request: vi.fn(),
  toast: vi.fn(),
  locale: 'en-US',
}));

const accountMocks = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, any>>,
  loading: false,
  error: '',
  requestAccounts: vi.fn(async () => {}),
  retryAccounts: vi.fn(async () => {}),
  call: vi.fn(),
  withAutoLogin: vi.fn(async (operation: () => Promise<unknown>) => ({
    result: await operation(),
    silentLoginSucceeded: false,
  })),
}));

vi.mock('../../../../shared/browserManager', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../shared/browserManager')>()),
  requestBrowserManager: managerMocks.request,
}));

vi.mock('../../../panel/utils/i18n', () => ({
  getCurrentLanguage: () => managerMocks.locale,
  t: (key: string) => key,
}));

vi.mock('../../../panel/utils/toast', () => ({
  showToast: managerMocks.toast,
}));

vi.mock('../../../panel/hooks/useAccounts', () => ({
  useAccounts: () => ({
    accounts: accountMocks.accounts,
    loading: accountMocks.loading,
    error: accountMocks.error,
    requestAccounts: accountMocks.requestAccounts,
    retryAccounts: accountMocks.retryAccounts,
  }),
}));

vi.mock('../../../panel/utils/accounts', () => ({
  fetchAccountSso: accountMocks.call,
  isAccountLoginError: (error?: string) => error === 'ACCOUNT_LOGIN_REQUIRED',
  withAccountAutoLogin: accountMocks.withAutoLogin,
}));

vi.mock('../../../panel/utils/qrCode', () => ({
  generateQrCodeSvgMarkup: (url: string) =>
    `<svg data-testid="provider-pairing-qr" data-url="${url}"></svg>`,
}));

function managedFixture(input: Record<string, any>): Record<string, any> {
  const {
    provider = 'local',
    persistent = false,
    headless,
    createdAt,
    cloudSessionId,
    cloudSessionMode,
    cloudImageId,
    cloudContextId,
    cloudContextName,
    pairingCode,
    ...browser
  } = input;
  const attached = cloudSessionMode === 'attached';
  const operations =
    browser.status === 'stopped'
      ? ['start', 'deleteData']
      : attached
        ? ['detach', 'access', 'syncCookies']
        : provider === 'example-cloud'
          ? ['close', 'access', 'syncCookies']
          : ['close'];
  return {
    ...browser,
    type: 'managed',
    provider: {
      id: provider,
      name:
        provider === 'example-cloud'
          ? 'Example Cloud'
          : provider === 'local'
            ? 'Local Chrome'
            : 'Example Device Provider',
      builtin: provider === 'local',
      version: '2.13.0',
      protocolVersion: 2,
    },
    ownership: attached ? 'attached' : 'owned',
    persistence: persistent ? 'persistent' : 'ephemeral',
    operations,
    references: [
      ...(cloudSessionId ? [{ kind: 'session', id: cloudSessionId, summary: true }] : []),
      ...(cloudImageId ? [{ kind: 'image', id: cloudImageId }] : []),
      ...(cloudContextId ? [{ kind: 'context', id: cloudContextId }] : []),
      ...(cloudContextName ? [{ kind: 'context-name', id: cloudContextName }] : []),
      ...(pairingCode ? [{ kind: 'pairing-code', id: pairingCode, summary: true }] : []),
    ],
    details: {
      ...(headless !== undefined ? { headless } : {}),
      ...(createdAt ? { createdAt } : {}),
    },
  };
}

const cloudProvider = {
  provider: { id: 'example-cloud', name: 'Example Cloud', builtin: false },
  browserType: {
    name: 'Example Cloud',
    documentationUrl: 'https://example.test/example-cloud',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string' as const,
          title: '实例名称',
          formWidth: 'half' as const,
          formHideOptional: true,
        },
        sessionId: {
          type: 'string' as const,
          title: 'Session ID',
          formWidth: 'half' as const,
        },
        reuse: {
          type: 'string' as const,
          title: '复用策略',
          enum: ['never', 'prefer', 'require'],
          default: 'never',
          formHidden: true,
        },
        persistent: {
          type: 'boolean' as const,
          component: 'switch' as const,
          title: '持久化 Profile',
          default: false,
          formDefault: true,
          formVisibleWhen: { field: 'sessionId', empty: true },
        },
        copyCookieDomains: {
          type: 'object' as const,
          component: 'cookie-sync' as const,
          title: 'Cookie',
          properties: {
            presets: { type: 'array' as const, items: { type: 'string' as const } },
            domains: { type: 'array' as const, items: { type: 'string' as const } },
          },
        },
      },
      oneOf: [
        {
          type: 'object' as const,
          required: ['name'],
          properties: {},
          not: { type: 'object' as const, required: ['sessionId'], properties: {} },
        },
        { type: 'object' as const, required: ['sessionId'], properties: {} },
      ],
    },
    configuration: {
      inputSchema: {
        type: 'object' as const,
        required: ['apiKey'],
        properties: {
          apiKey: {
            type: 'string' as const,
            title: 'Example Cloud API Key',
            secret: true,
            placeholder: 'provider-key',
          },
        },
      },
    },
  },
};

const localProvider = {
  provider: { id: 'local', name: 'Local Chrome', builtin: true },
  browserType: {
    name: '本地浏览器',
    inputSchema: {
      type: 'object' as const,
      required: ['name'],
      properties: {
        name: { type: 'string' as const },
        persistent: { type: 'boolean' as const, default: true },
        headless: { type: 'boolean' as const, default: true },
        copyCookieDomains: {
          type: 'object' as const,
          component: 'cookie-sync' as const,
          properties: {
            presets: { type: 'array' as const, items: { type: 'string' as const } },
            domains: { type: 'array' as const, items: { type: 'string' as const } },
          },
        },
      },
    },
  },
};

const dynamicProvider = {
  provider: { id: 'resource-fixture', name: 'Resources', builtin: false },
  browserType: {
    name: 'Resource fixture',
    dynamicLaunchForm: true,
    launchForm: staticResourceForm(),
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string' },
        region: { type: 'string' },
        attached: { type: 'boolean' },
        note: { type: 'string' },
      },
      additionalProperties: false,
      oneOf: [
        {
          type: 'object',
          properties: { resource: { type: 'string' } },
          required: ['resource'],
          not: {
            type: 'object',
            properties: { attached: { type: 'boolean' } },
            required: ['attached'],
          },
        },
        {
          type: 'object',
          properties: { attached: { type: 'boolean' } },
          required: ['attached'],
          not: {
            type: 'object',
            properties: { resource: { type: 'string' } },
            required: ['resource'],
          },
        },
      ],
    },
  },
};

function resourceForm(variant = 'rent', region = 'one') {
  return {
    variant,
    variants: [
      { id: 'rent', title: 'Create resource' },
      { id: 'attach', title: 'Use existing' },
    ],
    ...(variant === 'attach'
      ? {
          values: { attached: true },
          message: 'Existing resource ready',
          inputSchema: { type: 'object', properties: {} },
        }
      : {
          refreshOn: ['region'],
          dynamicFields: ['resource'],
          message: 'Choose a resource',
          inputSchema: {
            type: 'object',
            required: ['region', 'resource'],
            properties: {
              region: {
                type: 'string',
                title: 'Region',
                default: region,
                enum: ['one', 'two'],
                options: [
                  { value: 'one', label: 'First region' },
                  { value: 'two', label: 'Second region' },
                ],
              },
              note: { type: 'string', title: 'Note' },
              resource: {
                type: 'string',
                title: 'Resource',
                options: [
                  {
                    value: `free-${region}`,
                    label: `Available ${region}`,
                    description: 'Resource ID',
                  },
                  { value: 'busy', label: 'Busy resource', disabled: true },
                ],
              },
            },
          },
        }),
  };
}

function staticResourceForm() {
  const form = resourceForm() as any;
  delete form.message;
  form.inputSchema.properties.resource.options = [];
  form.variants[1] = {
    ...form.variants[1],
    inputSchema: { type: 'object', properties: {} },
    values: { attached: true },
    refreshOn: [],
    dynamicFields: [],
  };
  return form;
}

async function openDynamicProvider(
  query: (data: any) => any = data => resourceForm(data.variant, data.values.region),
  provider = dynamicProvider,
) {
  managerMocks.request.mockImplementation(async (operation: string, data: any) => {
    if (operation === 'list') return { browsers: [] };
    if (operation === 'providers') return { providers: [provider] };
    if (operation === 'launchForm') return query(data);
    return {};
  });
  render(<BrowserManager />);
  fireEvent.click(await screen.findByRole('button', { name: 'browserManagerNew' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Resource fixture' }));
}

describe('BrowserManager', () => {
  it.each([50, 350])(
    'only shows one delayed initial loading indicator for a %ims request',
    async delay => {
      vi.useFakeTimers();
      let resolveList!: (value: { browsers: [] }) => void;
      managerMocks.request.mockImplementation((operation: string) =>
        operation === 'list'
          ? new Promise(resolve => {
              resolveList = resolve;
            })
          : Promise.resolve({}),
      );
      const view = render(<BrowserManager />);
      try {
        expect(screen.queryByText('browserManagerLoading')).not.toBeInTheDocument();
        await act(async () => {
          vi.advanceTimersByTime(delay);
        });
        expect(Boolean(screen.queryByText('browserManagerLoading'))).toBe(delay >= 300);
        expect(
          screen
            .getByRole('button', { name: 'browserManagerRefresh' })
            .querySelector('.animate-spin'),
        ).toBeNull();
        await act(async () => {
          resolveList({ browsers: [] });
        });
        await act(async () => {
          vi.advanceTimersByTime(400);
        });
        expect(screen.queryByText('browserManagerLoading')).not.toBeInTheDocument();
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    managerMocks.locale = 'en-US';
    accountMocks.accounts = [];
    accountMocks.loading = false;
    accountMocks.error = '';
    accountMocks.call.mockResolvedValue({ success: true });
    window.localStorage.clear();
    chrome.tabs = {
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://current.example.com/account' }]),
    } as unknown as typeof chrome.tabs;
    chrome.permissions = {
      request: vi.fn((_permissions, callback) => callback(true)),
    } as unknown as typeof chrome.permissions;
    chrome.runtime.sendMessage = vi.fn(async message => {
      if (message?.action === 'browser_sessions' && message.data?.operation === 'list') {
        return { success: true, data: { sessions: [] } };
      }
      if (message?.action === 'getAgentStatus') {
        return {
          success: true,
          status: {
            connected: true,
            extensionVersion: '2.10.0',
            nativeHostVersion: '2.10.0',
          },
        };
      }
      return { success: true };
    }) as typeof chrome.runtime.sendMessage;
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] };
      }
      if (operation === 'providers') return { providers: [] };
      return {};
    });
    window.confirm = vi.fn(() => true);
  });

  it('renders caller navigation alongside the existing header actions', () => {
    const onBack = vi.fn();
    render(<BrowserManager onBack={onBack} headerActions={<button>switch tool</button>} />);
    fireEvent.click(screen.getByRole('button', { name: 'toolboxBack' }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'switch tool' })).toBeInTheDocument();
  });

  it('queries the defaults of the selected static mode before displaying resource choices', async () => {
    const provider = structuredClone(dynamicProvider);
    provider.browserType.launchForm.inputSchema.properties.region.default = 'two';
    await openDynamicProvider(data => resourceForm(data.variant, data.values.region), provider);
    await screen.findByText('Choose a resource');
    expect(managerMocks.request).toHaveBeenCalledWith('launchForm', {
      provider: 'resource-fixture',
      variant: 'rent',
      values: { region: 'two' },
    });
    expect(screen.getByRole('button', { name: 'Region' })).toHaveTextContent('Second region');
    fireEvent.click(screen.getByRole('radio', { name: 'Use existing' }));
    await screen.findByText('Existing resource ready');
    fireEvent.click(screen.getByRole('radio', { name: 'Create resource' }));
    await screen.findByText('Choose a resource');
    expect(managerMocks.request).toHaveBeenLastCalledWith('launchForm', {
      provider: 'resource-fixture',
      variant: 'rent',
      values: { region: 'two' },
    });
  });

  it('localizes provider form metadata without changing query values', async () => {
    managerMocks.locale = 'zh-CN';
    const form = resourceForm();
    const schema = form.inputSchema;
    const region = schema.properties.region!;
    await openDynamicProvider(() => ({
      ...form,
      locales: { zh: { message: '请选择资源' } },
      variants: form.variants.map(variant => ({
        ...variant,
        locales: { zh: { title: variant.id === 'rent' ? '创建资源' : '接入资源' } },
      })),
      inputSchema: {
        ...schema,
        properties: {
          ...schema.properties,
          region: {
            ...region,
            locales: { zh: { title: '地区' } },
            options: [
              { ...region.options[0], locales: { zh_CN: { label: '地区一' } } },
              ...region.options.slice(1),
            ],
          },
          note: {
            type: 'number',
            title: 'Reference',
            locales: { zh: { title: '编号', placeholder: '例如 123' } },
          },
        },
      },
    }));
    expect(await screen.findByText('请选择资源')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '创建资源' })).toBeChecked();
    expect(screen.getByRole('button', { name: '地区' })).toHaveTextContent('地区一');
    expect(screen.getByRole('spinbutton', { name: '编号' })).toHaveAttribute(
      'placeholder',
      '例如 123',
    );
    fireEvent.click(screen.getByRole('button', { name: '地区' }));
    fireEvent.click(screen.getByRole('option', { name: 'Second region' }));
    expect(managerMocks.request).toHaveBeenLastCalledWith('launchForm', {
      provider: 'resource-fixture',
      variant: 'rent',
      values: { region: 'two' },
    });
    await screen.findByText('请选择资源');
  });

  it('allows discovery while structured input is incomplete and retains explicitly cleared defaults', async () => {
    const provider = structuredClone(dynamicProvider);
    const schema = provider.browserType.launchForm.inputSchema;
    schema.properties.settings = { type: 'object', title: 'Settings', properties: {} };
    schema.properties.preference = {
      type: 'string',
      title: 'Preference',
      enum: ['default', 'custom'],
      default: 'default',
    };
    await openDynamicProvider(() => ({ ...resourceForm(), inputSchema: schema }), provider);
    await screen.findByText('Choose a resource');
    fireEvent.change(screen.getByLabelText('Settings'), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preference' }));
    fireEvent.click(screen.getByRole('option', { name: 'browserManagerOptional' }));
    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(screen.getByRole('button', { name: 'browserManagerRefreshOptions' }));
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Choose a resource'),
      );
      expect(screen.getByLabelText('Settings')).toHaveValue('{');
      expect(screen.getByRole('button', { name: 'Preference' })).toHaveTextContent(
        'browserManagerSelectOption',
      );
    }
    expect(managerMocks.request).toHaveBeenLastCalledWith('launchForm', {
      provider: 'resource-fixture',
      variant: 'rent',
      values: { region: 'one' },
    });
    expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeDisabled();
  });

  it('shows static form fields immediately and preserves editing while choices load', async () => {
    let resolve!: (form: unknown) => void;
    await openDynamicProvider(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('browserManagerLoadingOptions');
    expect(screen.getByRole('radio', { name: 'Create resource' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Use existing' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Region' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Resource' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resource' })).not.toHaveTextContent(
      'browserManagerLoadingOptions',
    );
    expect(screen.getByRole('button', { name: 'Resource' })).toHaveTextContent(
      'browserManagerSelectOption',
    );
    expect(screen.getByLabelText('Note')).toBeEnabled();
    expect(screen.queryByText('browserManagerOptional')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Keep my input' } });
    expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeDisabled();
    await act(async () => resolve(resourceForm()));
    expect(status).toHaveTextContent('Choose a resource');
    expect(status).not.toHaveTextContent('browserManagerLoadingOptions');
    expect(screen.getByLabelText('Note')).toHaveValue('Keep my input');
    expect(screen.getByRole('button', { name: 'Resource' })).toBeEnabled();
  });

  it('switches static modes during discovery and ignores the superseded response', async () => {
    const pending: Array<(form: unknown) => void> = [];
    await openDynamicProvider(
      () =>
        new Promise(done => {
          pending.push(done);
        }),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Use existing' }));
    expect(screen.getByRole('radio', { name: 'Use existing' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Resource' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeDisabled();
    await act(async () => pending[0]!(resourceForm()));
    expect(screen.queryByRole('button', { name: 'Resource' })).not.toBeInTheDocument();
    await act(async () => pending[1]!(resourceForm('attach')));
    expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeEnabled();
  });

  it('renders Provider-owned modes and choices and submits only the selected mode parameters', async () => {
    await openDynamicProvider();
    await screen.findByText('Choose a resource');
    fireEvent.click(await screen.findByRole('button', { name: 'Resource' }));
    expect(screen.getByRole('option', { name: 'Busy resource' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.click(screen.getByRole('option', { name: 'Busy resource' }));
    expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeDisabled();
    fireEvent.click(screen.getByRole('option', { name: 'Available one Resource ID' }));
    expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeEnabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Use existing' }));
    await screen.findByText('Existing resource ready');
    expect(screen.queryByRole('button', { name: 'Resource' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerAdd' }));
    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'resource-fixture',
        providerOptions: { attached: true },
      }),
    );
  });

  it('refreshes dependent choices, clears prior selections and omits attachment parameters when renting', async () => {
    await openDynamicProvider();
    await screen.findByText('Choose a resource');
    fireEvent.click(await screen.findByRole('button', { name: 'Resource' }));
    fireEvent.click(screen.getByRole('option', { name: 'Available one Resource ID' }));
    fireEvent.click(screen.getByRole('button', { name: 'Region' }));
    fireEvent.click(screen.getByRole('option', { name: 'Second region' }));
    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launchForm', {
        provider: 'resource-fixture',
        variant: 'rent',
        values: { region: 'two' },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resource' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Available two Resource ID' }));
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerAdd' }));
    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'resource-fixture',
        providerOptions: { region: 'two', resource: 'free-two' },
      }),
    );
  });

  it('keeps failed and blocked discovery unlaunchable and allows an explicit retry', async () => {
    let fail = true;
    await openDynamicProvider(() => {
      if (fail) throw new Error('Discovery unavailable');
      return { ...resourceForm('attach'), blocked: true, message: 'No existing resource' };
    });
    await screen.findByText('Discovery unavailable');
    expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeDisabled();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerRefreshOptions' }));
    await screen.findByText('No existing resource');
    expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeDisabled();
  });

  it('ignores discovery results after switching to another provider', async () => {
    let resolve!: (form: unknown) => void;
    await openDynamicProvider(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    await waitFor(() => expect(resolve).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerLocal' }));
    await act(async () => resolve(resourceForm()));
    expect(screen.queryByText('Choose a resource')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'browserManagerLaunch' })).toBeEnabled();
  });

  it('shows tasks under their browser and routes takeover, return and release to that session', async () => {
    managerMocks.request.mockResolvedValue({
      browsers: [
        { browserId: 'chrome-one', name: 'Chrome One', type: 'regular', status: 'connected' },
        { browserId: 'chrome-two', name: 'Chrome Two', type: 'regular', status: 'connected' },
      ],
    });
    let sessions = [
      {
        sessionId: 'session-one',
        browserId: 'chrome-one',
        transport: 'extension',
        status: 'active',
        tabs: [{ tabId: 10, title: 'Demo page', source: 'created' }],
      },
      {
        sessionId: 'session-two',
        browserId: 'chrome-two',
        transport: 'extension',
        status: 'user',
        reason: 'Please scan the code',
        tabs: [{ tabId: 20, title: 'Sign in', source: 'attached' }],
      },
    ];
    chrome.runtime.sendMessage = vi.fn(async message => {
      if (message.action === 'browser_sessions' && message.data?.operation === 'list')
        return { success: true, data: { sessions } };
      if (message.action === 'browser_sessions') {
        const { sessionId, operation } = message.data;
        sessions =
          operation === 'release'
            ? sessions.filter(session => session.sessionId !== sessionId)
            : sessions.map(session =>
                session.sessionId === sessionId
                  ? { ...session, status: operation === 'handoff' ? 'user' : 'active' }
                  : session,
              );
      }
      return { success: true };
    }) as typeof chrome.runtime.sendMessage;
    render(<BrowserManager />);
    const first = within(await screen.findByRole('region', { name: 'Chrome One' }));
    const second = within(screen.getByRole('region', { name: 'Chrome Two' }));
    expect(await first.findByText('Demo page')).toBeInTheDocument();
    expect(first.queryByText('Sign in')).not.toBeInTheDocument();
    expect(second.getByText('Sign in')).toBeInTheDocument();
    expect(second.getByText('Please scan the code')).toBeInTheDocument();
    fireEvent.click(first.getByRole('button', { name: 'controlSessionTakeOver' }));
    await first.findByRole('button', { name: 'controlSessionReturn' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'browser_sessions',
      data: { sessionId: 'session-one', operation: 'handoff' },
    });
    fireEvent.click(first.getByRole('button', { name: 'controlSessionReturn' }));
    await first.findByRole('button', { name: 'controlSessionTakeOver' });
    fireEvent.click(first.getByRole('button', { name: 'controlSessionFinish' }));
    await waitFor(() => expect(first.queryByText('Demo page')).not.toBeInTheDocument());
    expect(second.getByText('Sign in')).toBeInTheDocument();
  });

  it('reuses the Native Host install guide when browser management is unavailable', async () => {
    managerMocks.request
      .mockRejectedValueOnce(new Error('Native host disconnected'))
      .mockResolvedValueOnce({ count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] });
    chrome.runtime.sendMessage = vi.fn(async message => {
      if (message?.action === 'getAgentStatus') {
        return {
          success: true,
          status: {
            connected: false,
            extensionVersion: '2.10.0',
            nativeHostVersion: null,
          },
        };
      }
      return { success: true };
    }) as typeof chrome.runtime.sendMessage;

    render(<BrowserManager />);

    expect(await screen.findByText('agentChatNativeHostInstallTitle')).toBeInTheDocument();
    expect(screen.getByText('browserManagerNativeHostInstallDescription')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'browserManagerNew' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'agentChatNativeHostInstallReconnect' }));

    await waitFor(() => expect(managerMocks.request).toHaveBeenCalledTimes(2));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'resetAgentBridge' });
    expect(await screen.findByText('browserManagerEmpty')).toBeInTheDocument();
  });

  it('uses capability detection when the installed host lacks browser management', async () => {
    managerMocks.request.mockRejectedValueOnce(
      new ExtensionRpcError('PROTOCOL_MISMATCH', 'Update required'),
    );
    chrome.runtime.sendMessage = vi.fn(async message => {
      if (message?.action === 'getAgentStatus') {
        return {
          success: true,
          status: {
            connected: true,
            extensionVersion: '2.10.0',
            nativeHostVersion: '2.10.0',
          },
        };
      }
      return { success: true };
    }) as typeof chrome.runtime.sendMessage;

    render(<BrowserManager />);

    expect(await screen.findByText('agentChatNativeHostUpdateTitle')).toBeInTheDocument();
    expect(screen.getByText('browserManagerNativeHostUpdateDescription')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'browserManagerNew' })).toBeDisabled();
  });

  it('does not treat unrelated unknown actions as missing browser management', async () => {
    managerMocks.request.mockRejectedValueOnce(new Error('Unknown extension action: other_action'));

    render(<BrowserManager />);

    expect(await screen.findByText('Unknown extension action: other_action')).toBeInTheDocument();
    expect(screen.queryByText('agentChatNativeHostUpdateTitle')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'browserManagerNew' })).toBeEnabled();
  });

  it('shows a Provider pairing QR code without treating it as connected', async () => {
    managerMocks.request.mockResolvedValue({
      count: 1,
      connectedCount: 0,
      defaultBrowserId: null,
      browsers: [
        managedFixture({
          browserId: 'provider:example-device:pairing_fixture',
          name: 'Example Device · 扫码连接真机',
          status: 'pairing',
          transport: 'provider',
          provider: 'example-device',
          pairing: {
            kind: 'qr',
            url: 'https://example.test/device-pairing?id=pairing_fixture',
            code: 'pairing_fixture',
          },
        }),
      ],
    });

    const { container } = render(<BrowserManager />);

    expect(await screen.findByText('browserManagerStatusPairing')).toBeInTheDocument();
    expect(screen.getAllByText('Example Device Provider').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/pairing_fixture/).length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="provider-pairing-qr"]')).toHaveAttribute(
      'data-url',
      'https://example.test/device-pairing?id=pairing_fixture',
    );
  });

  it('shows Provider-specific references and JSON details', async () => {
    managerMocks.request.mockResolvedValue({
      count: 1,
      connectedCount: 1,
      browsers: [
        {
          browserId: 'provider:fixture:one',
          name: 'Custom device',
          type: 'managed',
          status: 'connected',
          provider: { id: 'fixture', name: 'Fixture', builtin: false },
          persistence: 'ephemeral',
          operations: [],
          references: [
            { kind: 'reference', id: 'fixture-123', label: 'Reference number' },
            { kind: 'device', id: 'device-42', label: 'Device identifier' },
          ],
          details: { region: 'cn-east', settings: { network: 'wifi' }, battery: 0 },
        },
      ],
    });
    render(<BrowserManager />);
    fireEvent.click(await screen.findByText('Custom device'));
    expect(screen.getByText('Reference number')).toBeInTheDocument();
    expect(screen.getByText('Device identifier')).toBeInTheDocument();
    expect(screen.getByText('cn-east')).toBeInTheDocument();
    expect(screen.getByText('{"network":"wifi"}')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();

    const deviceReference = screen.getByText('Device identifier').parentElement;
    const region = screen.getByText('region').parentElement;
    const battery = screen.getByText('battery');
    const settings = screen.getByText('settings');
    expect(deviceReference).not.toHaveClass('col-span-2');
    expect(region).not.toHaveClass('col-span-2');
    expect(settings.parentElement).toHaveClass('col-span-2');
    expect(
      battery.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows a connected Example Device pairing code in the collapsed summary', async () => {
    managerMocks.request.mockResolvedValue({
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'provider:example-device:pairing_fixture',
      browsers: [
        managedFixture({
          browserId: 'provider:example-device:pairing_fixture',
          name: '真机',
          status: 'connected',
          transport: 'provider',
          provider: 'example-device',
          pairingCode: 'pairing_fixture',
        }),
      ],
    });

    render(<BrowserManager />);

    expect(await screen.findByTitle('pairing_fixture')).toHaveTextContent('· pairing_fixture');
    expect(screen.queryByText('browserManagerBrowserId')).not.toBeInTheDocument();
  });

  it('shows browser discovery warnings returned by the Native Host', async () => {
    managerMocks.request.mockResolvedValue({
      count: 0,
      connectedCount: 0,
      defaultBrowserId: null,
      browsers: [],
      warnings: ['provider fixture: did not become ready within 2s'],
    });

    render(<BrowserManager />);

    expect(
      await screen.findByText('provider fixture: did not become ready within 2s'),
    ).toBeInTheDocument();
  });

  it('refreshes a pairing Provider until its device connects', async () => {
    let listCalls = 0;
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation !== 'list') return {};
      listCalls += 1;
      const connected = listCalls > 1;
      return {
        count: 1,
        connectedCount: connected ? 1 : 0,
        defaultBrowserId: connected ? 'provider:example-device:pairing_fixture' : null,
        browsers: [
          managedFixture({
            browserId: 'provider:example-device:pairing_fixture',
            name: 'Example Device · 扫码连接真机',
            status: connected ? 'connected' : 'pairing',
            transport: 'provider',
            provider: 'example-device',
            ...(connected
              ? {}
              : {
                  pairing: {
                    kind: 'qr',
                    url: 'https://example.test/device-pairing?id=pairing_fixture',
                    code: 'pairing_fixture',
                  },
                }),
          }),
        ],
      };
    });
    vi.useFakeTimers();

    try {
      await act(async () => {
        render(<BrowserManager />);
      });
      expect(screen.getByText('browserManagerStatusPairing')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(managerMocks.request).toHaveBeenCalledTimes(2);
      expect(screen.getByText('browserManagerStatusConnected')).toBeInTheDocument();
      expect(screen.queryByText('browserManagerStatusPairing')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders installed Providers from their declared schemas', async () => {
    managerMocks.request.mockImplementation(async operation =>
      operation === 'providers'
        ? {
            providers: [
              {
                provider: { id: 'local', builtin: true },
                browserType: {
                  name: 'Local Chrome',
                  inputSchema: { type: 'object', properties: {} },
                },
              },
              cloudProvider,
              {
                provider: { id: 'example-device', builtin: false },
                browserType: { name: '真机', inputSchema: { type: 'object', properties: {} } },
              },
            ],
          }
        : { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] },
    );
    render(<BrowserManager />);
    await screen.findByText('browserManagerEmpty');
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    await screen.findByRole('button', { name: '真机' });
    expect(screen.getByRole('button', { name: 'Example Cloud' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Local Chrome' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'browserManagerPersistent' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: 'browserManagerHeadless' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Example Cloud' }));
    expect(screen.getByText('Session ID')).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'browserManagerPersistent' }),
    ).not.toBeInTheDocument();
  });

  it('builds an external Provider form from its registered browser type', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] };
      }
      if (operation === 'providers') {
        return {
          providers: [
            {
              provider: { id: 'example-device', name: 'Example Device', builtin: false },
              browserType: {
                name: '真机',
                inputSchema: {
                  type: 'object',
                  properties: {
                    debugId: {
                      type: 'string',
                      title: '配对码',
                      placeholder: '留空自动生成',
                    },
                  },
                },
              },
            },
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);
    await screen.findByText('browserManagerEmpty');
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    fireEvent.click(await screen.findByRole('button', { name: '真机' }));
    fireEvent.change(screen.getByPlaceholderText('留空自动生成'), {
      target: { value: 'my_device' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerAdd' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'example-device',
        providerOptions: { debugId: 'my_device' },
      }),
    );
  });

  it('preserves structured Provider option types', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] };
      }
      if (operation === 'providers') {
        return {
          providers: [
            {
              provider: { id: 'fixture', name: 'Fixture', builtin: false },
              browserType: {
                name: 'Fixture browser',
                inputSchema: {
                  type: 'object',
                  required: ['retries'],
                  properties: {
                    enabled: { type: 'boolean', title: 'Enabled', default: true },
                    retries: { type: 'number', title: 'Retries', integer: true },
                    tags: { type: 'array', title: 'Tags', items: { type: 'string' } },
                    settings: {
                      type: 'object',
                      title: 'Settings',
                      properties: { region: { type: 'string' } },
                    },
                    strategy: {
                      type: 'string',
                      title: 'Strategy',
                      enum: ['safe', 'fast'],
                      default: 'safe',
                    },
                  },
                },
              },
            },
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);
    await screen.findByText('browserManagerEmpty');
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fixture browser' }));

    fireEvent.change(await screen.findByLabelText(/Retries/), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/Tags/), { target: { value: '["one","two"]' } });
    fireEvent.change(screen.getByLabelText(/Settings/), {
      target: { value: '{"region":"cn"}' },
    });
    const strategySelect = screen.getByRole('button', { name: 'Strategy' });
    expect(strategySelect).toHaveTextContent('safe');
    fireEvent.click(strategySelect);
    fireEvent.click(screen.getByRole('option', { name: 'fast' }));
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerAdd' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'fixture',
        providerOptions: {
          enabled: true,
          retries: 3,
          tags: ['one', 'two'],
          settings: { region: 'cn' },
          strategy: 'fast',
        },
      }),
    );
  });

  it('submits only parameters declared by the selected Provider', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] };
      }
      if (operation === 'providers') {
        return {
          providers: [
            {
              provider: { id: 'first', name: 'First', builtin: false },
              browserType: {
                name: 'First device',
                inputSchema: {
                  type: 'object',
                  properties: {
                    firstCode: {
                      type: 'string',
                      title: 'First code',
                      placeholder: 'first-code',
                    },
                  },
                },
              },
            },
            {
              provider: { id: 'second', name: 'Second', builtin: false },
              browserType: {
                name: 'Second device',
                inputSchema: {
                  type: 'object',
                  properties: {
                    secondCode: {
                      type: 'string',
                      title: 'Second code',
                      placeholder: 'second-code',
                    },
                  },
                },
              },
            },
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);
    await screen.findByText('browserManagerEmpty');
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    fireEvent.click(await screen.findByRole('button', { name: 'First device' }));
    fireEvent.change(screen.getByPlaceholderText('first-code'), {
      target: { value: 'first-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Second device' }));
    fireEvent.change(screen.getByPlaceholderText('second-code'), {
      target: { value: ' second-value ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerAdd' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'second',
        providerOptions: { secondCode: 'second-value' },
      }),
    );
  });

  it('closes a Provider browser instance through its lifecycle operation', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return {
          count: 1,
          connectedCount: 0,
          defaultBrowserId: null,
          browsers: [
            managedFixture({
              browserId: 'provider:example-device:pairing_fixture',
              name: '真机',
              status: 'pairing',
              transport: 'provider',
              provider: 'example-device',
              pairing: {
                kind: 'qr',
                url: 'https://example.test/device-pairing?id=pairing_fixture',
                code: 'pairing_fixture',
              },
            }),
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);
    expect(await screen.findByRole('button', { name: 'browserManagerClose' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerClose' }));
    expect(screen.getByText('browserManagerCloseConfirmInline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('close', {
        browser: 'provider:example-device:pairing_fixture',
      }),
    );
    expect(managerMocks.toast).toHaveBeenCalledWith('browserManagerCloseDone', 'success');
  });

  it('passes Example Cloud launch values through the external Provider schema', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] };
      }
      if (operation === 'providers') return { providers: [cloudProvider] };
      return {};
    });
    render(<BrowserManager />);
    await screen.findByText('browserManagerEmpty');

    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Example Cloud' }));
    expect(screen.getByRole('link', { name: 'Example Cloud' })).toHaveAttribute(
      'href',
      'https://example.test/example-cloud',
    );
    expect(screen.getByRole('button', { name: 'browserManagerAdd' })).toBeDisabled();
    expect(screen.queryByText('复用策略')).not.toBeInTheDocument();
    expect(screen.getByText('实例名称').parentElement).not.toHaveTextContent(
      'browserManagerOptional',
    );
    expect(screen.getByRole('switch', { name: '持久化 Profile' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.change(screen.getByText('Session ID').closest('label')!.querySelector('input')!, {
      target: { value: 'session-123' },
    });
    expect(screen.queryByRole('switch', { name: '持久化 Profile' })).not.toBeInTheDocument();
    const syncLogin = screen.getByRole('switch', { name: 'browserManagerSyncLogin' });
    expect(syncLogin).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('textbox', { name: /Cookie/ })).not.toBeInTheDocument();
    fireEvent.click(syncLogin);
    expect(screen.getByText('browserManagerCookieScope')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerAdd' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'example-cloud',
        providerOptions: {
          sessionId: 'session-123',
          copyCookieDomains: { presets: ['mearl-services'] },
        },
      }),
    );
    expect(window.confirm).not.toHaveBeenCalled();
    expect(managerMocks.toast).toHaveBeenCalledWith('browserManagerSyncLoginDone', 'success');
  });

  it('uses a Provider configuration schema after a missing-configuration error', async () => {
    let launchAttempts = 0;
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] };
      }
      if (operation === 'providers') return { providers: [cloudProvider] };
      if (operation === 'launch') {
        launchAttempts += 1;
        if (launchAttempts === 1) {
          throw new Error(
            'Example Cloud API key not found. Set EXAMPLE_CLOUD_KEY in ~/.mearl/.env.',
          );
        }
        return {};
      }
      if (operation === 'configure') return { configured: true, updated: false };
      return {};
    });

    render(<BrowserManager />);
    await screen.findByText('browserManagerEmpty');
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Example Cloud' }));
    expect(screen.queryByPlaceholderText('provider-key')).not.toBeInTheDocument();

    fireEvent.change(screen.getByText('实例名称').closest('label')!.querySelector('input')!, {
      target: { value: 'cloud-main' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerAdd' }));

    const keyInput = await screen.findByPlaceholderText('provider-key');
    expect(keyInput).toHaveAttribute('type', 'password');
    expect(
      screen.getByText('Example Cloud API key not found. Set EXAMPLE_CLOUD_KEY in ~/.mearl/.env.'),
    ).toBeInTheDocument();
    fireEvent.change(keyInput, { target: { value: 'secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerAdd' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('configure', {
        provider: 'example-cloud',
        options: { apiKey: 'secret-key' },
      }),
    );
    await waitFor(() => expect(launchAttempts).toBe(2));
    expect(window.localStorage.getItem('EXAMPLE_CLOUD_KEY')).toBeNull();
    expect(managerMocks.toast).toHaveBeenCalledWith('browserManagerLaunchDone', 'success');
  });

  it('copies a local DevTools link through the browser access button', async () => {
    const url = 'devtools://devtools/bundled/inspector.html?ws=127.0.0.1:59652/devtools/page/tab';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list')
        return {
          count: 1,
          connectedCount: 1,
          defaultBrowserId: 'managed:local',
          browsers: [
            {
              ...managedFixture({
                browserId: 'managed:local',
                name: 'local',
                status: 'connected',
                headless: true,
              }),
              operations: ['close', 'deleteData', 'access'],
            },
          ],
        };
      if (operation === 'access')
        return { browserAccess: { kind: 'cdp-devtools', url, sensitive: true } };
      return {};
    });
    render(<BrowserManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'browserManagerCopyAccess' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
    expect(managerMocks.request).toHaveBeenCalledWith('access', { browser: 'managed:local' });
    expect(managerMocks.toast).toHaveBeenCalledWith('browserManagerCopyAccessDone', 'success');
  });

  it('fetches and copies a fresh noVNC address for a running Example Cloud browser', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    let resolveAccess!: (value: unknown) => void;
    const accessResult = new Promise(resolve => {
      resolveAccess = resolve;
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return {
          count: 1,
          connectedCount: 1,
          defaultBrowserId: 'managed:example-cloud:cloud-main',
          browsers: [
            managedFixture({
              browserId: 'managed:example-cloud:cloud-main',
              name: 'cloud-main',
              type: 'managed',
              status: 'connected',
              provider: 'example-cloud',
              headless: false,
              persistent: true,
              createdAt: '2026-09-03T00:00:00.000Z',
              cloudSessionId: 'session-123',
              cloudSessionMode: 'owned',
            }),
          ],
        };
      }
      if (operation === 'access') {
        return accessResult;
      }
      return {};
    });

    render(<BrowserManager />);
    const accessButton = await screen.findByRole('button', {
      name: 'browserManagerCopyAccess',
    });
    const syncButton = screen.getByRole('button', { name: 'browserManagerSyncLogin' });
    expect(accessButton.querySelector('.lucide-link-2')).not.toBeNull();
    expect(syncButton.querySelector('.lucide-cookie')).not.toBeNull();
    fireEvent.click(accessButton);

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('access', {
        browser: 'managed:example-cloud:cloud-main',
      }),
    );
    expect(accessButton.querySelector('.lucide-loader-circle')).not.toBeNull();
    expect(syncButton).toBeDisabled();
    resolveAccess({
      browserAccess: {
        kind: 'example-cloud',
        url: 'https://cloud.example/access?ticket=fresh',
      },
    });
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith('https://cloud.example/access?ticket=fresh');
    expect(managerMocks.toast).toHaveBeenCalledWith('browserManagerCopyAccessDone', 'success');
  });

  it('opens the same cookie-scope picker when syncing a running Example Cloud browser', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return {
          count: 1,
          connectedCount: 1,
          defaultBrowserId: 'managed:example-cloud:cloud-main',
          browsers: [
            managedFixture({
              browserId: 'managed:example-cloud:cloud-main',
              name: 'cloud-main',
              type: 'managed',
              status: 'connected',
              provider: 'example-cloud',
              headless: false,
              persistent: true,
              createdAt: '2026-09-03T00:00:00.000Z',
              cloudSessionId: 'session-123',
              cloudSessionMode: 'owned',
            }),
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'browserManagerSyncLogin' }));
    expect(screen.getByText('browserManagerCookieScopeTitle')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('browserManagerCookieCurrentSite'));
    const syncButtons = screen.getAllByRole('button', { name: 'browserManagerSyncLogin' });
    fireEvent.click(syncButtons.at(-1)!);

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('syncCookies', {
        browser: 'managed:example-cloud:cloud-main',
        scope: {
          presets: ['mearl-services'],
          domains: ['current.example.com'],
        },
      }),
    );
  });

  it('defaults local persistence and headless mode to off', async () => {
    render(<BrowserManager />);
    await screen.findByText('browserManagerEmpty');

    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerLocal' }));
    fireEvent.change(screen.getByPlaceholderText('browserManagerNamePlaceholder'), {
      target: { value: 'local-visible' },
    });
    const persistentSwitch = screen.getByRole('switch', {
      name: 'browserManagerPersistent',
    });
    const headlessSwitch = screen.getByRole('switch', { name: 'browserManagerHeadless' });
    expect(persistentSwitch).toHaveAttribute('aria-checked', 'false');
    expect(headlessSwitch).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerLaunch' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'local',
        providerOptions: { name: 'local-visible', persistent: false, headless: false },
      }),
    );
  });

  it('generates a random name when launching a local browser without an explicit name', async () => {
    render(<BrowserManager />);
    await screen.findByText('browserManagerEmpty');

    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    expect(screen.getByRole('button', { name: 'browserManagerLaunch' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerLaunch' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'local',
        providerOptions: {
          name: expect.stringMatching(/^local-[a-z0-9]{6}$/),
          persistent: false,
          headless: false,
        },
      }),
    );
  });

  it('opens a selected Accounts account SSO URL in the launched local browser', async () => {
    accountMocks.accounts = [
      {
        id: 42,
        principalId: 2215152400159,
        loginId: 'qa-account',
        ownerName: '测试同学',
        site: 'shop',
      },
      { id: 43, principalId: 2215152400160, loginId: 'qa-account-2', site: 'shop' },
      { id: 44, principalId: 2215152400161, loginId: 'qa-account-3', site: 'shop' },
    ];
    accountMocks.call.mockResolvedValue({
      success: true,
      data: 'https://login.wapa.shop.com/sso?ticket=one-time',
    });
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] };
      }
      if (operation === 'providers') return { providers: [localProvider] };
      return {};
    });

    render(<BrowserManager accountsEnabled />);
    await screen.findByText('browserManagerEmpty');
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    expect(accountMocks.requestAccounts).toHaveBeenCalled();
    const syncLogin = await screen.findByRole('switch', { name: 'browserManagerSyncLogin' });
    const accountGroup = screen.getByRole('radiogroup', {
      name: 'browserManagerAccount',
    });
    expect(syncLogin.compareDocumentPosition(accountGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(syncLogin.closest('.divide-y')).toContainElement(accountGroup);
    expect(accountGroup).toHaveClass('grid-cols-2', 'sm:grid-cols-3');
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    const selectedAccount = screen.getByRole('radio', { name: 'qa-account' });
    expect(selectedAccount).toHaveClass('h-7');
    expect(screen.queryByText(/测试同学/)).not.toBeInTheDocument();
    fireEvent.click(selectedAccount);
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerLaunch' }));

    await waitFor(() =>
      expect(accountMocks.call).toHaveBeenCalledWith(2215152400159, 'shop', undefined),
    );
    expect(accountMocks.withAutoLogin).toHaveBeenCalled();
    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'local',
        providerOptions: {
          name: expect.stringMatching(/^qa-account-[a-z0-9]{6}$/),
          persistent: false,
          headless: false,
          url: 'https://login.wapa.shop.com/sso?ticket=one-time',
        },
      }),
    );
  });

  it('hides Accounts account selection when the global Accounts switch is off', async () => {
    accountMocks.accounts = [
      { id: 42, principalId: 2215152400159, loginId: 'qa-account', site: 'shop' },
    ];
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] };
      }
      if (operation === 'providers') return { providers: [localProvider] };
      return {};
    });

    render(<BrowserManager accountsEnabled={false} />);
    await screen.findByText('browserManagerEmpty');
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));

    expect(
      await screen.findByRole('switch', { name: 'browserManagerSyncLogin' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('radiogroup', { name: 'browserManagerAccount' }),
    ).not.toBeInTheDocument();
    expect(accountMocks.requestAccounts).not.toHaveBeenCalled();
  });

  it('uses the declared cookie-sync component when launching a local browser', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return { count: 0, connectedCount: 0, defaultBrowserId: null, browsers: [] };
      }
      if (operation === 'providers') {
        return {
          providers: [
            {
              provider: { id: 'local', name: 'Local Chrome', builtin: true },
              browserType: {
                name: '本地浏览器',
                inputSchema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    persistent: { type: 'boolean', default: true },
                    headless: { type: 'boolean', default: true },
                    copyCookieDomains: {
                      type: 'object',
                      component: 'cookie-sync',
                      properties: {
                        presets: { type: 'array', items: { type: 'string' } },
                        domains: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);
    await screen.findByText('browserManagerEmpty');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'browserManagerNew' }));
    });
    fireEvent.change(screen.getByPlaceholderText('browserManagerNamePlaceholder'), {
      target: { value: 'local-with-login' },
    });
    const syncLogin = await screen.findByRole('switch', { name: 'browserManagerSyncLogin' });
    fireEvent.click(syncLogin);
    fireEvent.click(await screen.findByText('browserManagerCookieScope'));
    fireEvent.click(await screen.findByText('browserManagerCookieCurrentSite'));
    fireEvent.click(screen.getByRole('button', { name: 'browserManagerLaunch' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('launch', {
        provider: 'local',
        providerOptions: {
          name: 'local-with-login',
          persistent: false,
          headless: false,
          copyCookieDomains: {
            presets: ['mearl-services'],
            domains: ['current.example.com'],
          },
        },
      }),
    );
    expect(chrome.permissions.request).toHaveBeenCalled();
    expect(window.localStorage.getItem('mearl.browserManager.cookieSyncScope')).toContain(
      'current.example.com',
    );
  });

  it('confirms closing inline before running the close action', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return {
          count: 1,
          connectedCount: 1,
          defaultBrowserId: 'managed:local:local-visible',
          browsers: [
            managedFixture({
              browserId: 'managed:local:local-visible',
              name: 'local-visible',
              type: 'managed',
              status: 'connected',
              provider: 'local',
              headless: false,
              persistent: true,
              createdAt: '2026-09-03T00:00:00.000Z',
              source: { kind: 'local' },
              transport: 'cdp',
            }),
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);
    const closeButton = await screen.findByRole('button', { name: 'browserManagerClose' });
    expect(screen.queryByRole('button', { name: 'browserManagerCleanup' })).not.toBeInTheDocument();
    const expandButton = screen.getByRole('button', {
      name: 'browserManagerShowDetails: local-visible',
    });
    expect(closeButton.compareDocumentPosition(expandButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(closeButton);
    expect(screen.getByText('browserManagerCloseConfirmInline')).toBeInTheDocument();
    expect(managerMocks.request).not.toHaveBeenCalledWith('close', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('close', {
        browser: 'managed:local:local-visible',
      }),
    );
    expect(window.confirm).not.toHaveBeenCalled();
    expect(managerMocks.toast).toHaveBeenCalledWith('browserManagerCloseDone', 'success');
  });

  it('allows a running but disconnected managed browser to be closed', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return {
          count: 1,
          connectedCount: 0,
          defaultBrowserId: null,
          browsers: [
            managedFixture({
              browserId: 'managed:local:reconnecting',
              name: 'reconnecting',
              type: 'managed',
              status: 'running_disconnected',
              provider: 'local',
              headless: true,
              persistent: true,
              createdAt: '2026-09-03T00:00:00.000Z',
            }),
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);

    expect(await screen.findByRole('button', { name: 'browserManagerClose' })).toBeEnabled();
  });

  it('shows a stopped persistent profile with restart and cleanup actions', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return {
          count: 1,
          connectedCount: 0,
          defaultBrowserId: null,
          browsers: [
            managedFixture({
              browserId: 'managed:local-profile',
              name: 'local-profile',
              type: 'managed',
              status: 'stopped',
              provider: 'local',
              headless: false,
              persistent: true,
              createdAt: '2026-09-03T00:00:00.000Z',
              source: { kind: 'local' },
            }),
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);
    expect(await screen.findByText('browserManagerProfile')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'browserManagerStart' }));
    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('start', {
        browser: 'managed:local-profile',
      }),
    );

    const cleanupButton = await screen.findByRole('button', { name: 'browserManagerCleanup' });
    const expandButton = screen.getByRole('button', {
      name: 'browserManagerShowDetails: local-profile',
    });
    expect(cleanupButton.compareDocumentPosition(expandButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    fireEvent.click(cleanupButton);
    expect(screen.getByText('browserManagerCleanupConfirmInline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('close', {
        browser: 'managed:local-profile',
        deleteProfile: true,
      }),
    );
    expect(window.confirm).not.toHaveBeenCalled();
    expect(managerMocks.toast).toHaveBeenCalledWith('browserManagerCleanupDone', 'success');
  });

  it('releases an attached Session without closing the cloud Session', async () => {
    managerMocks.request.mockImplementation(async (operation: string) => {
      if (operation === 'list') {
        return {
          count: 1,
          connectedCount: 1,
          defaultBrowserId: 'managed:example-cloud:session:session-123',
          browsers: [
            managedFixture({
              browserId: 'managed:example-cloud:session:session-123',
              name: 'session-123',
              type: 'managed',
              status: 'connected',
              provider: 'example-cloud',
              headless: false,
              persistent: false,
              createdAt: '2026-09-03T00:00:00.000Z',
              cloudSessionId: 'session-123',
              cloudSessionMode: 'attached',
              cloudContextId: 'context-123',
              source: { kind: 'remote', connectorName: 'office-mac' },
              transport: 'cdp',
            }),
          ],
        };
      }
      return {};
    });

    render(<BrowserManager />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'browserManagerShowDetails: session-123',
      }),
    );
    expect(screen.getByText('context-123')).toBeInTheDocument();
    expect(screen.getByText('browserManagerSourceRemote · office-mac')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'browserManagerDetach' }));

    await waitFor(() =>
      expect(managerMocks.request).toHaveBeenCalledWith('detach', {
        browser: 'managed:example-cloud:session:session-123',
      }),
    );
    expect(window.confirm).toHaveBeenCalledWith('browserManagerDetachConfirm');
    expect(managerMocks.toast).toHaveBeenCalledWith('browserManagerDetachDone', 'success');
  });
  it.each([false, true])(
    'starts and syncs an external instance (additional site: %s)',
    async includeSite => {
      const browserId = 'provider:fixture:existing';
      let started = false;
      managerMocks.request.mockImplementation(async (operation: string) => {
        if (operation === 'start') started = true;
        if (operation === 'list')
          return {
            count: 1,
            connectedCount: started ? 1 : 0,
            defaultBrowserId: null,
            browsers: [
              {
                browserId,
                name: 'External device',
                type: 'managed',
                provider: { id: 'fixture', name: 'Fixture', builtin: false },
                persistence: 'persistent',
                status: started ? 'connected' : 'stopped',
                operations: started ? ['syncCookies'] : ['start'],
              },
            ],
          };
        return {};
      });
      render(<BrowserManager />);
      fireEvent.click(await screen.findByRole('button', { name: 'browserManagerStart' }));
      await waitFor(() =>
        expect(managerMocks.request).toHaveBeenCalledWith('start', { browser: browserId }),
      );
      fireEvent.click(await screen.findByRole('button', { name: 'browserManagerSyncLogin' }));
      if (includeSite) fireEvent.click(await screen.findByText('browserManagerCookieCurrentSite'));
      fireEvent.click(screen.getAllByRole('button', { name: 'browserManagerSyncLogin' }).at(-1)!);
      await waitFor(() =>
        expect(managerMocks.request).toHaveBeenCalledWith('syncCookies', {
          browser: browserId,
          scope: {
            presets: ['mearl-services'],
            ...(includeSite ? { domains: ['current.example.com'] } : {}),
          },
        }),
      );
      expect(managerMocks.request.mock.calls.some(([operation]) => operation === 'launch')).toBe(
        false,
      );
    },
  );
});
