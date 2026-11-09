import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickSettingsMenu } from '../QuickSettingsMenu';
import { networkControlFixture } from '../../../../../test/fixtures/networkControl';
import type { SelectedBrowserControl } from '@mearl/preset/bundles';
import { BROWSER_EXTENSION_UPDATE_VERSION_KEY } from '../../../../../shared/extensionUpdate';
import { SERVICE_DEFAULTS_CACHE_KEY } from '../../../../../shared/externalServices';
import { listBuiltinAppProfiles } from '../../../../../../../app-profiles/src/__tests__/fixtures';

const configMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
const browserUiMocks = vi.hoisted(() => ({
  appProfiles: [] as Array<{ id: string; label: string; available?: boolean }>,
  control: undefined as SelectedBrowserControl | undefined,
  settings: {} as { mtopGateways?: Record<string, { prod: string; pre: string }> },
}));
const permissionPromptMocks = vi.hoisted(() => ({
  getPageHostPermissionGranted: vi.fn(),
  showHostPermissionPromptIfNeeded: vi.fn(),
}));
const toastMocks = vi.hoisted(() => ({ showToast: vi.fn() }));
const installationMocks = vi.hoisted(() => ({ getExtensionInstallationInfo: vi.fn() }));
const remoteConfigMocks = vi.hoisted(() => ({ fetchRemoteConfig: vi.fn() }));
const DEFAULT_VISIBLE_DEVICE_SELECTION = {
  preset: 'iphone-17-pro',
  orientation: 'portrait',
  fitToWindow: true,
  deviceShell: true,
  splitScreen: false,
} as const;

vi.mock('../../../utils/i18n', () => ({
  getCurrentLanguage: () => 'zh_CN',
  initI18n: vi.fn().mockResolvedValue(undefined),
  t: (key: string, substitutions?: string | string[]) => {
    const messages: Record<string, string> = {
      agentFloatingButton: '侧边栏悬浮入口',
      deviceSimulation: '设备模拟',
      deviceSimulationApp: '客户端',
      deviceSimulationMobileDevice: '移动设备',
      deviceSimulationCustom: '自定义',
      deviceSimulationChangeFailed: '设备模拟切换失败',
      deviceSimulationAuto: '自动开启端与设备模拟',
      deviceSimulationAutoHint: '访问 $1 下的页面时，自动开启最后选择的端与设备',
      deviceSimulationAutoEnabledHint: '已为 $1 开启自动模拟，点击关闭',
      deviceSimulationAutoUnavailable: '当前页面不支持按根域自动模拟',
      deviceSimulationAutoChangeFailed: '自动模拟设置失败',
      deviceSimulationEnableLandscape: '开启横屏',
      deviceSimulationDisableLandscape: '关闭横屏',
      deviceSimulationSplitScreen: '分屏模拟',
      deviceSimulationSplitScreenHint: '横屏时左侧保留首页，后续页面在右侧打开',
      deviceSimulationFitToWindow: '适应窗口',
      deviceSimulationFitToWindowHint: '缩小画面以完整显示设备视口',
      deviceSimulationShell: '系统栏',
      deviceSimulationPhoneFrame: '手机壳',
      deviceSimulationShellHint: '使用 iframe WebView 并展示系统栏',
      deviceSimulationIosAdaptive: 'iOS（自适应）',
      deviceSimulationAndroidAdaptive: 'Android（自适应）',
      deviceSimulationIphone17Pro: 'iPhone 17 Pro',
      deviceSimulationIphoneDuoFolded: 'iPhone Duo（折叠）',
      deviceSimulationIphoneDuoUnfolded: 'iPhone Duo（展开）',
      deviceSimulationIphone17e: 'iPhone 17e',
      deviceSimulationPixel11: 'Pixel 11',
      deviceSimulationIpadMiniA17Pro: 'iPad mini (A17 Pro)',
      deviceSimulationGalaxyS26: 'Galaxy S26',
      deviceSimulationPuraXMax: 'Pura X Max',
      appSimulationReader: '阅读器',
      appSimulationShop: '商城',
      appSimulationWallet: '钱包',
      appSimulationChat: '聊天',
      appSimulationShowMore: '展开更多',
      appSimulationCancelHint: '再次点击取消模拟',
      appSimulationChangeFailed: 'APP 模拟切换失败',
      appProfileInstallTitle: '添加端模拟',
      appProfileInstallAction: '添加端模拟',
      appProfileInstallWeChat: '微信端模拟',
      appProfileInstallSource: '端模拟来源',
      extensionUpdateAvailable: '发现新版本 v$1',
      extensionUpdateNow: '立即更新',
      extensionUpdating: '更新中...',
      extensionChangelog: '更新日志',
      extensionUpdateReloading: '更新完成，正在重新加载插件',
      extensionUpdateFailed: '插件更新失败',
      extensionAlreadyLatest: '当前已是最新版本',
    };
    const message = messages[key] ?? key;
    const replacement = Array.isArray(substitutions) ? substitutions[0] : substitutions;
    return message.replace('$1', replacement ?? '$1');
  },
}));

vi.mock('../../../utils/config', () => ({
  DEFAULT_CONFIG: {
    language: 'zh_CN',
    agentEnabled: true,
    agentFloatingButtonEnabled: false,
  },
  getConfig: configMocks.getConfig,
  updateConfig: configMocks.updateConfig,
  onConfigChange: vi.fn(() => () => {}),
}));
vi.mock('../../../utils/browserUiSettings', () => ({
  useBrowserAppProfiles: () => browserUiMocks.appProfiles,
  useBrowserControl: (text: (key: string) => string) =>
    browserUiMocks.control ??
    networkControlFixture(browserUiMocks.settings, key => ({ en: text(key) })),
}));

vi.mock('../../../hooks/useContentScriptUnreachableToast', () => ({
  getPageHostPermissionGranted: permissionPromptMocks.getPageHostPermissionGranted,
  showHostPermissionPromptIfNeeded: permissionPromptMocks.showHostPermissionPromptIfNeeded,
}));

vi.mock('../../../utils/toast', () => toastMocks);

vi.mock('../../../../../shared/extensionInstallation', () => ({
  getExtensionInstallationInfo: installationMocks.getExtensionInstallationInfo,
}));

vi.mock('../../../../../shared/remoteConfig', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../../shared/remoteConfig')>()),
  fetchRemoteConfig: remoteConfigMocks.fetchRemoteConfig,
}));

vi.mock('../../../../../shared/hooks/useFontSize', () => ({
  useFontSize: () => ({ currentLevel: 1, totalLevels: 4, setLevel: vi.fn() }),
}));

describe('QuickSettingsMenu', () => {
  it('loads the actual environment before the first menu hover without assuming the default', async () => {
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    let finish!: (value: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) =>
      (args[0] as { action?: string }).action === 'browserControlGet'
        ? (new Promise(resolve => {
            finish = resolve;
          }) as never)
        : original(...args),
    );
    const view = render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(view.container.querySelector('[data-quick-settings-open]')).toHaveAttribute(
      'data-quick-settings-open',
      'false',
    );
    expect(screen.getByText('envSwitchOff')).toHaveAttribute('aria-pressed', 'false');
    await act(async () => {
      finish({ success: true, value: 'pre' });
    });
    expect(screen.getByText('requestEnvironmentPreRelease')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'requestEnvironmentPreRelease' })).toBeVisible(),
    );
    expect(screen.getByRole('button', { name: 'requestEnvironmentPreRelease' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'browserControlGet',
      tabId: 1,
    });
    expect(
      vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.filter(
          ([request]) =>
            (request as unknown as { action?: string })?.action === 'browserControlGet',
        ),
    ).toHaveLength(1);
  });

  it('tracks tab changes while closed and keeps the same tab selection on a transient read failure', async () => {
    let activate!: () => void;
    chrome.tabs.onActivated = {
      addListener: vi.fn(listener => {
        activate = listener;
      }),
      removeListener: vi.fn(),
    } as unknown as typeof chrome.tabs.onActivated;
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    let failure = false;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      const request = args[0] as { action?: string; tabId?: number };
      if (request.action === 'browserControlGet')
        return (
          failure
            ? Promise.reject(new Error('Temporary failure'))
            : Promise.resolve({ success: true, value: request.tabId === 1 ? 'pre' : 'prod' })
        ) as never;
      return original(...args);
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText('requestEnvironmentPreRelease')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    failure = true;
    await act(async () => {
      activate();
    });
    expect(screen.getByText('requestEnvironmentPreRelease')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    chrome.devtools.inspectedWindow.tabId = 2;
    await act(async () => {
      activate();
    });
    expect(screen.getByText('requestEnvironmentPreRelease')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    failure = false;
    await act(async () => {
      activate();
    });
    expect(screen.getByText('requestEnvironmentProd')).toHaveAttribute('aria-pressed', 'true');
    chrome.devtools.inspectedWindow.tabId = 1;
  });

  it('discards a late environment result after its preset changes', async () => {
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    let finish!: (value: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) =>
      (args[0] as { action?: string }).action === 'browserControlGet'
        ? (new Promise(resolve => {
            finish = resolve;
          }) as never)
        : original(...args),
    );
    const { rerender } = render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const finishOld = finish;
    browserUiMocks.settings = {
      mtopGateways: { next: { prod: 'next.example.test', pre: 'pre.next.example.test' } },
    };
    rerender(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    await waitFor(() => expect(finish).not.toBe(finishOld));
    await act(async () => {
      finishOld({ success: true, value: 'pre' });
    });
    expect(screen.getByText('requestEnvironmentPreRelease')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await act(async () => {
      finish({ success: true, value: 'prod' });
    });
    expect(screen.getByText('requestEnvironmentProd')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders package-defined choices in the original menu and binds actions to their exact owner', async () => {
    const control = networkControlFixture(browserUiMocks.settings, key => ({ en: key }))!;
    browserUiMocks.control = {
      ...control,
      bundleId: 'example',
      revision: 'custom',
      definition: {
        ...control.definition,
        label: { en: 'Request target' },
        options: [
          control.definition.options[0],
          { ...control.definition.options[1], value: 'qa', label: { en: 'QA' } },
        ],
      },
    };
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const qa = await screen.findByRole('button', { name: 'QA' });
    expect(screen.getByText('Request target')).toBeInTheDocument();
    expect(screen.queryByText('requestEnvironmentProd')).toBeNull();
    fireEvent.click(qa);
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'browserControlSet',
        tabId: 1,
        value: 'qa',
        controlId: 'environment',
        bundleId: 'example',
        revision: 'custom',
      }),
    );
    await waitFor(() => expect(qa).toHaveAttribute('aria-pressed', 'true'));
  });
  it('shows configured Protocol gateways without relying on the network reachability', async () => {
    chrome.storage.session.get = vi.fn(async () => ({
      [SERVICE_DEFAULTS_CACHE_KEY]: {},
    })) as unknown as typeof chrome.storage.session.get;
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'requestEnvironmentPreRelease' })).toBeEnabled(),
    );
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'browserControlGet' }),
      ),
    );
    expect(configMocks.updateConfig).not.toHaveBeenCalled();
  });

  it('hides Protocol controls without configured gateways and follows preset changes while open', async () => {
    browserUiMocks.settings = {};
    const { rerender } = render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    await waitFor(() => expect(screen.getByRole('button', { name: '阅读器' })).toBeVisible());
    expect(screen.queryByText('envSwitch')).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'browserControlGet' }),
    );
    browserUiMocks.settings = {
      mtopGateways: { enterprise: { prod: 'api.example.test', pre: 'pre.example.test' } },
    };
    rerender(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'requestEnvironmentPreRelease' })).toBeEnabled(),
    );
    browserUiMocks.settings = { mtopGateways: {} };
    rerender(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    expect(screen.queryByText('envSwitch')).toBeNull();
    expect(configMocks.updateConfig).not.toHaveBeenCalled();
  });

  it('loads and changes the inspected tab environment without saving a global preference', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const pre = await screen.findByRole('button', { name: 'requestEnvironmentPreRelease' });
    await waitFor(() => expect(pre).toBeEnabled());
    fireEvent.click(pre);
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'browserControlSet',
        tabId: 1,
        value: 'pre',
        controlId: 'environment',
        bundleId: 'fixture',
        revision: JSON.stringify(browserUiMocks.settings.mtopGateways),
      }),
    );
    await waitFor(() => expect(pre).toHaveAttribute('aria-pressed', 'true'));
    expect(configMocks.updateConfig).not.toHaveBeenCalled();
    expect(toastMocks.showToast).toHaveBeenCalledWith('envSwitchReloadHint', 'info');
  });

  it('keeps environment controls usable when reading the current environment fails', async () => {
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      if ((args[0] as { action?: string }).action === 'browserControlGet') {
        return Promise.resolve({ success: false }) as never;
      }
      return original(...args);
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const reset = await screen.findByRole('button', { name: 'envSwitchOff' });
    expect(reset).toBeEnabled();
    expect(screen.getByRole('button', { name: 'requestEnvironmentPreRelease' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'requestEnvironmentProd' })).toBeEnabled();
    fireEvent.click(reset);
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'browserControlSet',
        tabId: 1,
        value: 'default',
        controlId: 'environment',
        bundleId: 'fixture',
        revision: JSON.stringify(browserUiMocks.settings.mtopGateways),
      }),
    );
    await waitFor(() => expect(reset).toHaveAttribute('aria-pressed', 'true'));
  });

  it('retains the selected environment and reports a failed write', async () => {
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      if ((args[0] as { action?: string }).action === 'browserControlSet') {
        return Promise.resolve({ success: false, error: 'DNR update failed' }) as never;
      }
      return original(...args);
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const pre = await screen.findByRole('button', { name: 'requestEnvironmentPreRelease' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'envSwitchOff' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    fireEvent.click(pre);
    await waitFor(() =>
      expect(toastMocks.showToast).toHaveBeenCalledWith('envSwitchChangeFailed', 'error'),
    );
    expect(screen.getByRole('button', { name: 'envSwitchOff' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(pre).toBeEnabled();
  });

  it('refreshes the environment after switching tabs and receiving an Agent update', async () => {
    let activate!: () => void;
    const changes: Array<
      (changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName) => void
    > = [];
    chrome.tabs.onActivated = {
      addListener: vi.fn(listener => {
        activate = listener;
      }),
      removeListener: vi.fn(),
    } as unknown as typeof chrome.tabs.onActivated;
    vi.mocked(chrome.storage.onChanged.addListener).mockImplementation(listener => {
      changes.push(listener);
    });
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    let secondTarget = 'default';
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      const request = args[0] as { action?: string; tabId?: number };
      if (request.action === 'browserControlGet') {
        return Promise.resolve({
          success: true,
          value: request.tabId === 1 ? 'pre' : secondTarget,
        }) as never;
      }
      return original(...args);
    });
    try {
      render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
      fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'requestEnvironmentPreRelease' }),
        ).toHaveAttribute('aria-pressed', 'true'),
      );
      chrome.devtools.inspectedWindow.tabId = 2;
      act(() => activate());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'envSwitchOff' })).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );
      secondTarget = 'prod';
      act(() =>
        changes.forEach(change =>
          change({ 'networkControlV1:2': { newValue: 'prod' } }, 'session'),
        ),
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'requestEnvironmentProd' })).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );
    } finally {
      chrome.devtools.inspectedWindow.tabId = 1;
    }
  });

  it('hides App controls while discovery is pending and exposes only installed profiles', async () => {
    const existingHandler = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    let finishCatalog!: (result: unknown) => void;
    const catalog = new Promise(resolve => {
      finishCatalog = resolve;
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      if ((args[0] as { action?: string }).action === 'appProfileCatalogGet')
        return catalog as never;
      return existingHandler(...args);
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'appProfileCatalogGet' }),
    );
    expect(screen.queryByRole('menu', { name: '客户端' })).toBeNull();
    expect(screen.queryByRole('button', { name: '自动开启端与设备模拟' })).toBeNull();
    expect(screen.getByRole('button', { name: 'iPhone 17 Pro' })).toBeEnabled();
    await act(async () =>
      finishCatalog({
        success: true,
        profiles: [
          { id: 'partner/app', label: 'Partner App', available: true },
          { id: 'missing/app', label: 'Missing App', available: false },
        ],
      }),
    );
    const menu = await screen.findByRole('menu', { name: '客户端' });
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map(item => item.textContent),
    ).toEqual(['Partner App']);
    expect(screen.queryByText('Missing App')).toBeNull();
    expect(screen.getByRole('button', { name: 'Partner App' })).toBeEnabled();
    fireEvent.click(within(menu).getByRole('menuitem', { name: '添加端模拟' }));
    const dialog = within(await screen.findByRole('dialog', { name: '添加端模拟' }));
    const source = dialog.getByRole('textbox', { name: '端模拟来源' });
    fireEvent.click(dialog.getByRole('button', { name: /微信/ }));
    expect(source).toHaveValue('mearlhq/wechat-profile');
    fireEvent.change(source, { target: { value: 'example/profiles' } });
    expect(source).toHaveValue('example/profiles');
    const close = dialog.getByTitle('Close (ESC)');
    const install = dialog.getByRole('button', { name: 'appProfileInstallSubmit' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(install).toHaveFocus();
    fireEvent.keyDown(install, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Partner App' })).toHaveFocus());
  });

  it('renders installed App controls on the first open while the full catalog is still pending', async () => {
    browserUiMocks.appProfiles = [{ id: 'partner/app', label: 'Partner App' }];
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) =>
      (args[0] as { action?: string }).action === 'appProfileCatalogGet'
        ? new Promise(() => {})
        : original(...args),
    );
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ action: 'appProfileCatalogGet' });
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const app = await screen.findByRole('button', { name: 'Partner App' });
    await waitFor(() => expect(app).toBeEnabled());
    expect(screen.getByRole('button', { name: 'iPhone 17 Pro' })).toBeEnabled();
    fireEvent.click(app);
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'quickAppProfileSet', profile: 'partner/app' }),
      ),
    );
  });

  it('discards an earlier full catalog after the installed selection changes', async () => {
    browserUiMocks.appProfiles = [{ id: 'old/app', label: 'Old App' }];
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    let finish!: (result: unknown) => void;
    let pending = new Promise(resolve => {
      finish = resolve;
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) =>
      (args[0] as { action?: string }).action === 'appProfileCatalogGet'
        ? pending
        : original(...args),
    );
    const view = render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    await screen.findByRole('button', { name: 'Old App' });
    await waitFor(() =>
      expect(view.container.querySelector('[data-quick-settings-open]')).toHaveAttribute(
        'data-quick-settings-open',
        'true',
      ),
    );
    pending = new Promise(() => {});
    browserUiMocks.appProfiles = [{ id: 'new/app', label: 'New App' }];
    view.rerender(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'New App' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Old App' })).toBeNull();
    // A completed request from the previous selection cannot replace the new bootstrap.
    await act(async () =>
      finish({ success: true, profiles: [{ id: 'old/app', label: 'Old App' }] }),
    );
    expect(screen.queryByRole('button', { name: 'Old App', hidden: true })).toBeNull();
  });
  it('opens the installer directly when no App capability is installed', async () => {
    const existingHandler = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      if ((args[0] as { action?: string }).action === 'appProfileCatalogGet')
        return Promise.resolve({ success: true, profiles: [] }) as never;
      return existingHandler(...args);
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    const gear = screen.getByRole('button', { name: 'settings' });
    expect(gear).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(gear);
    expect(gear).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'appProfileCatalogGet' }),
    );
    expect(screen.queryByRole('menu', { name: '客户端' })).toBeNull();
    expect(screen.queryByRole('button', { name: '自动开启端与设备模拟' })).toBeNull();
    expect(screen.getByRole('button', { name: 'iPhone 17 Pro' })).toBeEnabled();
    const app = screen.getByRole('button', { name: '客户端' });
    expect(app).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(app);
    expect(await screen.findByRole('dialog', { name: '添加端模拟' })).toBeInTheDocument();
  });

  it('ignores a remembered App that arrives after its removal from the catalog', async () => {
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    let finishProfile!: (value: unknown) => void;
    const profile = new Promise(resolve => {
      finishProfile = resolve;
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      const request = args[0] as { action?: string };
      if (request.action === 'appProfileCatalogGet')
        return Promise.resolve({ success: true, profiles: [] }) as never;
      if (request.action === 'quickAppProfileGet') return profile as never;
      return original(...args);
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings' }));
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'appProfileCatalogGet' }),
    );
    await act(async () => finishProfile({ success: true, profile: null, lastProfile: 'travel' }));
    expect(screen.getByRole('button', { name: '客户端' })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
    expect(screen.queryByRole('button', { name: 'travel' })).toBeNull();
  });

  it('allows closing an active App after its catalog becomes unavailable without offering reactivation', async () => {
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      const request = args[0] as { action?: string };
      if (request.action === 'appProfileCatalogGet')
        return Promise.resolve({ success: true, profiles: [] }) as never;
      if (request.action === 'quickAppProfileGet')
        return Promise.resolve({ success: true, profile: 'partner/app' }) as never;
      return original(...args);
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const close = await screen.findByRole('button', { name: 'partner/app' });
    expect(close).toHaveAttribute('aria-pressed', 'true');
    expect(close).toHaveAttribute('aria-haspopup', 'menu');
    const menu = screen.getByRole('menu', { name: '客户端' });
    expect(within(menu).queryByRole('menuitemradio')).toBeNull();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'partner/app' })).toBeNull());
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'quickAppProfileSet', profile: null }),
    );
  });

  it('allows disabling an existing automatic rule without an installed App', async () => {
    const original = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      const request = args[0] as { action?: string };
      if (request.action === 'appProfileCatalogGet')
        return Promise.resolve({ success: true, profiles: [] }) as never;
      if (request.action === 'quickSimulationAutoRuleGet')
        return Promise.resolve({ success: true, enabled: true, domain: 'example.test' }) as never;
      return original(...args);
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const close = await screen.findByRole('button', { name: '自动开启端与设备模拟' });
    await waitFor(() => expect(close).toBeEnabled());
    fireEvent.click(close);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '自动开启端与设备模拟' })).toBeNull(),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickSimulationAutoRuleSet',
      tabId: 1,
      enabled: false,
    });
  });

  it('uses the installed catalog order for the primary profiles', async () => {
    const existingHandler = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args) => {
      if ((args[0] as { action?: string }).action === 'appProfileCatalogGet') {
        return Promise.resolve({
          success: true,
          profiles: [
            ...listBuiltinAppProfiles().reverse(),
            { id: 'partner/tmall', label: '天猫', available: true },
          ],
        }) as never;
      }
      return existingHandler(...args);
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const menu = await screen.findByRole('menu', { name: '客户端' });
    await waitFor(() =>
      expect(menu.closest('[data-quick-settings-open]')).toHaveAttribute(
        'data-quick-settings-open',
        'true',
      ),
    );
    fireEvent.focus(screen.getByRole('button', { name: '聊天' }));
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'appProfileCatalogGet' }),
    );
    fireEvent.click(await within(menu).findByRole('menuitem', { name: '展开更多' }));
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .slice(0, 4)
        .map(item => item.textContent),
    ).toEqual(['聊天', '钱包', '手机商城', '阅读器']);
  });

  beforeEach(() => {
    browserUiMocks.appProfiles = [];
    browserUiMocks.control = undefined;
    browserUiMocks.settings = {
      mtopGateways: { enterprise: { prod: 'api.example.test', pre: 'pre.example.test' } },
    };
    chrome.storage.session = {
      get: vi.fn(async () => ({
        [SERVICE_DEFAULTS_CACHE_KEY]: {},
      })),
    } as unknown as typeof chrome.storage.session;
    configMocks.getConfig.mockReset().mockResolvedValue({
      language: 'zh_CN',
      agentEnabled: true,
      agentFloatingButtonEnabled: true,
    });
    configMocks.updateConfig.mockReset().mockResolvedValue(undefined);
    permissionPromptMocks.getPageHostPermissionGranted.mockReset().mockResolvedValue(true);
    permissionPromptMocks.showHostPermissionPromptIfNeeded.mockReset().mockResolvedValue(false);
    toastMocks.showToast.mockReset();
    installationMocks.getExtensionInstallationInfo.mockReset().mockResolvedValue({
      extensionId: 'test-extension-id',
      extensionVersion: '2.8.0',
      setupManagedPath: null,
    });
    remoteConfigMocks.fetchRemoteConfig.mockReset().mockRejectedValue(new Error('offline'));
    chrome.runtime.reload = vi.fn();
    chrome.storage.local.get = vi.fn((_keys, callback) => {
      callback?.({});
    }) as unknown as typeof chrome.storage.local.get;
    chrome.tabs = {
      create: vi.fn().mockResolvedValue({ id: 2 }),
    } as unknown as typeof chrome.tabs;
    vi.mocked(chrome.runtime.sendMessage)
      .mockReset()
      .mockImplementation(async message => {
        const request = message as unknown as {
          action?: string;
          value?: string;
          profile?: unknown;
          os?: 'ios' | 'android';
          preset?: string;
          orientation?: 'portrait' | 'landscape';
          fitToWindow?: boolean;
          deviceShell?: boolean;
          splitScreen?: boolean;
          deviceSelection?: {
            preset: string;
            orientation: 'portrait' | 'landscape';
            fitToWindow: boolean;
            deviceShell: boolean;
            splitScreen?: boolean;
          };
          enabled?: boolean;
          appVersion?: string;
        };
        if (request.action === 'appProfileCatalogGet')
          return {
            success: true,
            profiles: [
              ...listBuiltinAppProfiles(),
              { id: 'partner/tmall', label: '天猫', available: true },
            ],
          };
        if (request.action === 'browserControlGet' || request.action === 'browserControlSet') {
          return { success: true, value: request.value ?? 'default' };
        }
        if (request.action === 'quickAppProfileGet') {
          return { success: true, profile: null, os: 'ios' };
        }
        if (request.action === 'quickDeviceEmulationGet') {
          return { success: true, active: false, orientation: 'portrait' };
        }
        if (request.action === 'quickSimulationAutoRuleGet') {
          return { success: true, enabled: false, domain: 'shop.com' };
        }
        if (request.action === 'quickSimulationAutoRuleSet') {
          return {
            success: true,
            enabled: request.enabled,
            domain: 'shop.com',
            ...(request.enabled
              ? {
                  rule: {
                    domain: 'shop.com',
                    profile: request.profile,
                    ...(request.appVersion ? { appVersion: request.appVersion } : {}),
                    deviceSelection: request.deviceSelection,
                  },
                }
              : {}),
          };
        }
        if (request.action === 'quickDeviceEmulationSet') {
          return {
            success: true,
            active: true,
            preset: request.preset,
            orientation: request.orientation,
            fitToWindow: request.fitToWindow,
            deviceShell: request.deviceShell,
            splitScreen: request.splitScreen,
          };
        }
        if (request.action === 'quickDeviceEmulationClear') {
          return { success: true, active: false, preset: null, orientation: 'portrait' };
        }
        if (request.action === 'quickAppProfileSet') {
          const selection = request.deviceSelection ?? DEFAULT_VISIBLE_DEVICE_SELECTION;
          return {
            success: true,
            profile: request.profile,
            appVersion: request.profile ? '10.0.0' : undefined,
            os: request.os ?? 'ios',
            device: {
              success: true,
              active: Boolean(request.profile),
              ...selection,
            },
          };
        }
        if (request.action === 'quickDeviceShellSet') {
          return {
            success: true,
            active: true,
            preset: 'iphone-17-pro',
            orientation: 'portrait',
            fitToWindow: true,
            deviceShell: request.deviceShell,
            splitScreen: true,
          };
        }
        if (request.action === 'quickDeviceSplitScreenSet') {
          return {
            success: true,
            active: true,
            preset: 'iphone-17-pro',
            orientation: 'landscape',
            fitToWindow: true,
            deviceShell: true,
            splitScreen: request.splitScreen,
          };
        }
        return undefined;
      });
  });

  it('shows an update dot and explicit update actions for a newer setup release', async () => {
    installationMocks.getExtensionInstallationInfo.mockResolvedValue({
      extensionId: 'test-extension-id',
      extensionVersion: '2.8.0',
      setupManagedPath: '/home/test/.mearl/chrome-extension',
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string };
      if (request.action === 'updateSetupExtension') {
        return { success: true, updated: true, version: '2.8.1' };
      }
      if (request.action === 'quickAppProfileGet') return { success: true, profile: null };
      if (request.action === 'quickDeviceEmulationGet') return { success: true, active: false };
      return undefined;
    });
    render(
      <QuickSettingsMenu
        onShowSettings={vi.fn()}
        remoteConfig={{
          latestVersion: '2.8.1',
          downloadUrl:
            'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
        }}
      />,
    );

    expect(await screen.findByTestId('extension-update-dot')).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const updateButton = await screen.findByRole('button', { name: '立即更新' });
    fireEvent.click(screen.getByRole('button', { name: '更新日志' }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      active: true,
      url: 'https://github.com/mearlhq/mearl/releases/tag/v2.8.1',
    });

    fireEvent.click(updateButton);
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'updateSetupExtension' }),
    );
    expect(toastMocks.showToast).toHaveBeenCalledWith('更新完成，正在重新加载插件', 'success');
  });

  it('does not show update UI for a store installation', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    await waitFor(() => expect(installationMocks.getExtensionInstallationInfo).toHaveBeenCalled());
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'updateSetupExtension' }),
    );
    expect(remoteConfigMocks.fetchRemoteConfig).not.toHaveBeenCalled();
    expect(screen.queryByTestId('extension-update-dot')).toBeNull();
    expect(screen.queryByRole('button', { name: '立即更新' })).toBeNull();
  });

  it('loads remote config on demand for a standalone setup-managed menu', async () => {
    installationMocks.getExtensionInstallationInfo.mockResolvedValue({
      extensionId: 'test-extension-id',
      extensionVersion: '2.8.0',
      setupManagedPath: '/home/test/.mearl/chrome-extension',
    });
    remoteConfigMocks.fetchRemoteConfig.mockResolvedValue({
      latestVersion: '2.8.1',
      downloadUrl:
        'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
    });

    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);

    expect(await screen.findByTestId('extension-update-dot')).toBeInTheDocument();
    expect(remoteConfigMocks.fetchRemoteConfig).toHaveBeenCalledOnce();
  });

  it('offers the same update actions when Chrome has downloaded a browser-managed update', async () => {
    chrome.storage.local.get = vi.fn((_keys, callback) => {
      callback?.({ [BROWSER_EXTENSION_UPDATE_VERSION_KEY]: '2.8.1' });
    }) as unknown as typeof chrome.storage.local.get;

    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);

    expect(await screen.findByTestId('extension-update-dot')).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    fireEvent.click(await screen.findByRole('button', { name: '更新日志' }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      active: true,
      url: 'https://github.com/mearlhq/mearl/releases/tag/v2.8.1',
    });

    fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
    expect(toastMocks.showToast).toHaveBeenCalledWith('更新完成，正在重新加载插件', 'success');
    await waitFor(() => expect(chrome.runtime.reload).toHaveBeenCalledOnce());
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
      action: 'updateSetupExtension',
    });
    expect(remoteConfigMocks.fetchRemoteConfig).not.toHaveBeenCalled();
  });

  it('通过菜单选择客户端，并通过主按钮按上次选择快速关闭和开启', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    expect(await screen.findByText('设备模拟')).toBeInTheDocument();
    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    const reader = within(appMenu).getByRole('menuitemradio', { name: '阅读器' });
    await waitFor(() => expect(reader).toBeEnabled());
    fireEvent.click(reader);

    await waitFor(() => expect(reader).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('button', { name: '阅读器' })).toHaveAttribute('aria-pressed', 'true');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickAppProfileSet',
      tabId: 1,
      profile: 'reader',
      deviceSelection: DEFAULT_VISIBLE_DEVICE_SELECTION,
    });
    expect(screen.getByRole('button', { name: 'iPhone 17 Pro' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(appMenu).queryByRole('menuitemradio', { name: '关闭' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '阅读器' }));
    const inactiveAppButton = await screen.findByRole('button', { name: '阅读器' });
    expect(inactiveAppButton).toHaveAttribute('aria-pressed', 'false');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickAppProfileSet',
      tabId: 1,
      profile: null,
    });

    fireEvent.click(inactiveAppButton);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '阅读器' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
      action: 'quickAppProfileSet',
      tabId: 1,
      profile: 'reader',
      deviceSelection: DEFAULT_VISIBLE_DEVICE_SELECTION,
    });
  });

  it('按当前根域自动开启最后选择的客户端和设备', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const autoButton = await screen.findByRole('button', { name: '自动开启端与设备模拟' });
    await waitFor(() => expect(autoButton).toBeEnabled());
    expect(autoButton).toHaveAttribute(
      'title',
      '访问 shop.com 下的页面时，自动开启最后选择的端与设备',
    );

    fireEvent.click(autoButton);

    await waitFor(() => expect(autoButton).toHaveAttribute('aria-pressed', 'true'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickSimulationAutoRuleSet',
      tabId: 1,
      enabled: true,
      profile: 'reader',
      deviceSelection: DEFAULT_VISIBLE_DEVICE_SELECTION,
      applyToTab: true,
    });
    expect(autoButton).toHaveAttribute('title', '已为 shop.com 开启自动模拟，点击关闭');

    fireEvent.click(
      within(screen.getByRole('menu', { name: '客户端' })).getByRole('menuitemradio', {
        name: '手机商城',
      }),
    );
    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'quickAppProfileSet',
        tabId: 1,
        profile: 'shop',
        deviceSelection: DEFAULT_VISIBLE_DEVICE_SELECTION,
      }),
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'quickSimulationAutoRuleSet',
        applyToTab: false,
      }),
    );

    fireEvent.click(autoButton);
    await waitFor(() => expect(autoButton).toHaveAttribute('aria-pressed', 'false'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickSimulationAutoRuleSet',
      tabId: 1,
      enabled: false,
    });
  });

  it('开启和关闭客户端模拟不发送设备模拟设置或清除', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    const reader = within(appMenu).getByRole('menuitemradio', { name: '阅读器' });
    await waitFor(() => expect(reader).toBeEnabled());
    vi.mocked(chrome.runtime.sendMessage).mockClear();

    fireEvent.click(reader);
    await waitFor(() => expect(reader).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(screen.getByRole('button', { name: '阅读器' }));
    await waitFor(() => expect(reader).toHaveAttribute('aria-checked', 'false'));

    expect(
      vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([request]) => {
        const action = (request as unknown as { action?: string }).action;
        return action === 'quickDeviceEmulationSet' || action === 'quickDeviceEmulationClear';
      }),
    ).toEqual([]);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickAppProfileSet',
      tabId: 1,
      profile: 'reader',
      deviceSelection: DEFAULT_VISIBLE_DEVICE_SELECTION,
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickAppProfileSet',
      tabId: 1,
      profile: null,
    });
  });

  it('再次点击已选择的客户端或设备选项会关闭对应模拟', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    const reader = within(appMenu).getByRole('menuitemradio', { name: '阅读器' });
    await waitFor(() => expect(reader).toBeEnabled());
    fireEvent.click(reader);
    await waitFor(() => expect(reader).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(reader);
    await waitFor(() => expect(reader).toHaveAttribute('aria-checked', 'false'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickAppProfileSet',
      tabId: 1,
      profile: null,
    });

    const deviceMenu = screen.getByRole('menu', { name: '移动设备' });
    const pura = within(deviceMenu).getByRole('menuitemradio', { name: 'Pura X Max' });
    fireEvent.click(pura);
    await waitFor(() => expect(pura).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(pura);
    await waitFor(() => expect(pura).toHaveAttribute('aria-checked', 'false'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceEmulationClear',
      tabId: 1,
    });
  });

  it('shows the App profile already active on the inspected tab', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string; profile?: unknown };
      if (request.action === 'quickAppProfileGet') return { success: true, profile: 'chat' };
      return { success: true, profile: request.profile };
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    const chat = await within(appMenu).findByRole('menuitemradio', { name: '聊天' });
    await waitFor(() => expect(chat).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('button', { name: '聊天' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(appMenu).getByRole('menuitemradio', { name: '阅读器' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('shows the last App profile as the inactive default after reload', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: null, lastProfile: 'chat' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return { success: true, active: false, preset: 'iphone-17-pro' };
      }
      if (request.action === 'quickSimulationAutoRuleGet') {
        return { success: true, enabled: false, domain: 'shop.com' };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appButton = await screen.findByRole('button', { name: '聊天' });

    expect(appButton).toHaveAttribute('aria-pressed', 'false');
    expect(
      within(screen.getByRole('menu', { name: '客户端' })).getByRole('menuitemradio', {
        name: '聊天',
      }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps global inactive defaults when the current tab has a different automatic rule', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: null, lastProfile: 'chat' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: false,
          preset: 'iphone-duo-unfolded',
          orientation: 'landscape',
          fitToWindow: true,
          deviceShell: true,
          splitScreen: true,
        };
      }
      if (request.action === 'quickSimulationAutoRuleGet') {
        return {
          success: true,
          enabled: true,
          domain: 'shop.com',
          rule: {
            domain: 'shop.com',
            profile: 'reader',
            deviceSelection: DEFAULT_VISIBLE_DEVICE_SELECTION,
          },
        };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    expect(await screen.findByRole('button', { name: '聊天' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'iPhone Duo（展开）' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('restores the client and mobile preset as independent active choices', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string };
      if (request.action === 'quickAppProfileGet') {
        return {
          success: true,
          profile: 'reader',
          appVersion: '10.0.0',
          os: 'ios',
        };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return { success: true, active: true, preset: 'pixel-11' };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    const deviceMenu = screen.getByRole('menu', { name: '移动设备' });
    await waitFor(() =>
      expect(within(appMenu).getByRole('menuitemradio', { name: '阅读器' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(within(deviceMenu).getByRole('menuitemradio', { name: 'Pixel 11' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('button', { name: '阅读器' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Pixel 11' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('hides device-only controls while device simulation is inactive', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appButton = await screen.findByRole('button', { name: '阅读器' });
    const deviceButton = screen.getByRole('button', { name: 'iPhone 17 Pro' });

    expect(appButton).toHaveAttribute('aria-pressed', 'false');
    expect(deviceButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '自动开启端与设备模拟' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '适应窗口' })).toBeNull();
    expect(screen.queryByRole('button', { name: /横屏/ })).toBeNull();
    expect(screen.queryByTestId('device-fit-to-window-icon')).toBeNull();
    expect(screen.queryByTestId('device-landscape-toggle-icon')).toBeNull();
  });

  it('关闭客户端时同步关闭设备模拟，并在重新开启时恢复历史设备', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as {
        action?: string;
        profile?: unknown;
        os?: 'ios' | 'android';
      };
      if (request.action === 'quickAppProfileGet') {
        return {
          success: true,
          profile: 'reader',
          appVersion: '10.0.0',
          os: 'android',
        };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: true,
          preset: 'pixel-11',
          orientation: 'portrait',
          fitToWindow: true,
        };
      }
      if (request.action === 'quickAppProfileSet') {
        return {
          success: true,
          profile: request.profile,
          appVersion: request.profile ? '10.0.0' : null,
          os: 'android',
          device: {
            success: true,
            active: Boolean(request.profile),
            preset: 'pixel-11',
            orientation: 'portrait',
            fitToWindow: true,
            deviceShell: true,
          },
        };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    await screen.findByRole('menu', { name: '客户端' });

    const appButton = await screen.findByRole('button', { name: '阅读器' });
    const deviceButton = screen.getByRole('button', { name: 'Pixel 11' });
    await waitFor(() => expect(appButton).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(appButton);

    await waitFor(() => expect(appButton).toHaveAttribute('aria-pressed', 'false'));
    expect(deviceButton).toHaveAttribute('aria-pressed', 'false');
    expect(
      vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.some(
          ([request]) =>
            (request as unknown as { action?: string }).action === 'quickDeviceEmulationClear',
        ),
    ).toBe(false);

    fireEvent.click(appButton);
    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
        action: 'quickAppProfileSet',
        tabId: 1,
        profile: 'reader',
        deviceSelection: {
          preset: 'pixel-11',
          orientation: 'portrait',
          fitToWindow: true,
          deviceShell: true,
          splitScreen: false,
        },
      });
      expect(deviceButton).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('手动关闭客户端时同步关闭当前域的自动模拟状态', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string; profile?: unknown };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: 'reader', appVersion: '10.0.0', os: 'ios' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: true,
          preset: 'iphone-17-pro',
          orientation: 'portrait',
          fitToWindow: true,
          deviceShell: true,
        };
      }
      if (request.action === 'quickSimulationAutoRuleGet') {
        return {
          success: true,
          enabled: true,
          domain: 'shop.com',
          rule: {
            domain: 'shop.com',
            profile: 'reader',
            appVersion: '10.0.0',
            deviceSelection: DEFAULT_VISIBLE_DEVICE_SELECTION,
          },
        };
      }
      if (request.action === 'quickAppProfileSet') {
        return {
          success: true,
          profile: request.profile,
          device: { success: true, active: false, preset: 'iphone-17-pro' },
        };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    await screen.findByRole('menu', { name: '客户端' });

    const autoButton = await screen.findByRole('button', { name: '自动开启端与设备模拟' });
    const appButton = await screen.findByRole('button', { name: '阅读器' });
    await waitFor(() => expect(autoButton).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(appButton);

    await waitFor(() => expect(appButton).toHaveAttribute('aria-pressed', 'false'));
    expect(autoButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('手动关闭设备时同步关闭当前域的自动模拟状态', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: 'reader', appVersion: '10.0.0', os: 'ios' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return { success: true, active: true, ...DEFAULT_VISIBLE_DEVICE_SELECTION };
      }
      if (request.action === 'quickSimulationAutoRuleGet') {
        return {
          success: true,
          enabled: true,
          domain: 'shop.com',
          rule: {
            domain: 'shop.com',
            profile: 'reader',
            appVersion: '10.0.0',
            deviceSelection: DEFAULT_VISIBLE_DEVICE_SELECTION,
          },
        };
      }
      if (request.action === 'quickDeviceEmulationClear') {
        return { success: true, active: false, preset: 'iphone-17-pro' };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    await screen.findByRole('menuitemradio', { name: '阅读器' });

    const autoButton = await screen.findByRole('button', { name: '自动开启端与设备模拟' });
    const deviceButton = await screen.findByRole('button', { name: 'iPhone 17 Pro' });
    await waitFor(() => expect(autoButton).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(deviceButton).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(deviceButton);

    await waitFor(() => expect(deviceButton).toHaveAttribute('aria-pressed', 'false'));
    expect(autoButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('仅在设备模拟启用时切换设备外壳', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as {
        action?: string;
        deviceShell?: boolean;
        enabled?: boolean;
      };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: null, os: 'ios' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: true,
          preset: 'iphone-17-pro',
          orientation: 'portrait',
          fitToWindow: true,
          deviceShell: true,
        };
      }
      if (request.action === 'quickDeviceShellSet') {
        return {
          success: true,
          active: true,
          preset: 'iphone-17-pro',
          orientation: 'portrait',
          fitToWindow: true,
          deviceShell: request.deviceShell,
        };
      }
      if (request.action === 'quickDevicePhoneFrameSet') {
        return { success: true, phoneFrame: request.enabled };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const toggle = await screen.findByRole('button', { name: '系统栏' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const frame = screen.getByRole('button', { name: '手机壳' });
    fireEvent.click(frame);
    await waitFor(() => expect(frame).toHaveAttribute('aria-pressed', 'true'));
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDevicePhoneFrameSet',
      tabId: 1,
      enabled: true,
    });

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.queryByRole('button', { name: '手机壳' })).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceShellSet',
      tabId: 1,
      deviceShell: false,
    });
  });

  it('App 开关不重复发送由设备状态决定的系统字段', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as {
        action?: string;
        profile?: unknown;
        os?: 'ios' | 'android';
      };
      if (request.action === 'quickAppProfileGet') {
        await Promise.resolve();
        return { success: true, profile: null, os: 'ios' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: true,
          preset: 'pixel-11',
          orientation: 'portrait',
        };
      }
      if (request.action === 'quickAppProfileSet') {
        return {
          success: true,
          profile: request.profile,
          appVersion: '10.0.0',
          os: request.os,
        };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    const reader = within(appMenu).getByRole('menuitemradio', { name: '阅读器' });
    await waitFor(() => expect(reader).toBeEnabled());
    fireEvent.click(reader);

    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'quickAppProfileSet',
        tabId: 1,
        profile: 'reader',
        deviceSelection: {
          preset: 'pixel-11',
          orientation: 'portrait',
          fitToWindow: true,
          deviceShell: true,
          splitScreen: false,
        },
      }),
    );
    expect(screen.queryByRole('menuitemradio', { name: 'iOS' })).toBeNull();
    expect(screen.queryByRole('menuitemradio', { name: 'Android' })).toBeNull();
  });

  it('已知设备预设通过单个按钮在横竖屏间切换', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as {
        action?: string;
        preset?: string;
        orientation?: 'portrait' | 'landscape';
        fitToWindow?: boolean;
      };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: null, os: 'ios' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: true,
          preset: 'pixel-11',
          orientation: 'portrait',
          fitToWindow: false,
        };
      }
      if (request.action === 'quickDeviceEmulationSet') {
        return {
          success: true,
          active: true,
          preset: request.preset,
          orientation: request.orientation,
          fitToWindow: request.fitToWindow,
        };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const portrait = await screen.findByRole('button', { name: '开启横屏' });
    expect(screen.queryByRole('button', { name: '分屏模拟' })).toBeNull();
    fireEvent.click(portrait);

    const landscape = await screen.findByRole('button', { name: '关闭横屏' });
    expect(landscape).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('device-landscape-toggle-icon')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '分屏模拟' })).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceEmulationSet',
      tabId: 1,
      preset: 'pixel-11',
      orientation: 'landscape',
      fitToWindow: false,
      deviceShell: true,
      splitScreen: false,
    });

    fireEvent.click(landscape);
    await screen.findByRole('button', { name: '开启横屏' });
    expect(screen.queryByRole('button', { name: '分屏模拟' })).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
      action: 'quickDeviceEmulationSet',
      tabId: 1,
      preset: 'pixel-11',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
      splitScreen: false,
    });
  });

  it('横屏时在横屏按钮左侧展示并持久化分屏开关', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as {
        action?: string;
        splitScreen?: boolean;
        deviceShell?: boolean;
      };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: 'reader', os: 'ios' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: true,
          preset: 'iphone-17-pro',
          orientation: 'landscape',
          fitToWindow: true,
          deviceShell: true,
          splitScreen: true,
        };
      }
      if (request.action === 'quickDeviceSplitScreenSet') {
        return {
          success: true,
          active: true,
          preset: 'iphone-17-pro',
          orientation: 'landscape',
          fitToWindow: true,
          deviceShell: true,
          splitScreen: request.splitScreen,
        };
      }
      if (request.action === 'quickDeviceShellSet') {
        return { success: true, deviceShell: request.deviceShell, splitScreen: false };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const splitScreen = await screen.findByRole('button', { name: '分屏模拟' });
    const landscape = screen.getByRole('button', { name: '关闭横屏' });
    expect(splitScreen).toHaveAttribute('aria-pressed', 'true');
    expect(
      splitScreen.compareDocumentPosition(landscape) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(splitScreen);
    await waitFor(() => expect(splitScreen).toHaveAttribute('aria-pressed', 'false'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceSplitScreenSet',
      tabId: 1,
      splitScreen: false,
    });

    const shell = screen.getByRole('button', { name: '系统栏' });
    fireEvent.click(shell);
    await waitFor(() => expect(screen.queryByRole('button', { name: '分屏模拟' })).toBeNull());
    fireEvent.click(shell);
    await screen.findByRole('button', { name: '分屏模拟' });
  });

  it('回填并切换当前设备的适应窗口状态', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as {
        action?: string;
        preset?: string;
        orientation?: 'portrait' | 'landscape';
        fitToWindow?: boolean;
      };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: null, os: 'android' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: true,
          preset: 'pixel-11',
          orientation: 'portrait',
          fitToWindow: false,
        };
      }
      if (request.action === 'quickDeviceEmulationSet') {
        return {
          success: true,
          active: true,
          preset: request.preset,
          orientation: request.orientation,
          fitToWindow: request.fitToWindow,
        };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const fitToWindow = await screen.findByRole('button', { name: '适应窗口' });
    expect(fitToWindow).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(fitToWindow);

    await waitFor(() => expect(fitToWindow).toHaveAttribute('aria-pressed', 'true'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceEmulationSet',
      tabId: 1,
      preset: 'pixel-11',
      orientation: 'portrait',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
  });

  it('主设备按钮关闭再开启时保留适应窗口偏好', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as {
        action?: string;
        preset?: string;
        orientation?: 'portrait' | 'landscape';
        fitToWindow?: boolean;
      };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: null, os: 'android' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: true,
          preset: 'pixel-11',
          orientation: 'portrait',
          fitToWindow: false,
        };
      }
      if (request.action === 'quickDeviceEmulationClear') {
        return { success: true, active: false };
      }
      if (request.action === 'quickDeviceEmulationSet') {
        return {
          success: true,
          active: true,
          preset: request.preset,
          orientation: request.orientation,
          fitToWindow: request.fitToWindow,
        };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const activeDevice = await screen.findByRole('button', { name: 'Pixel 11' });
    fireEvent.click(activeDevice);
    const inactiveDevice = await screen.findByRole('button', { name: 'Pixel 11' });
    expect(inactiveDevice).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(inactiveDevice);

    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
        action: 'quickDeviceEmulationSet',
        tabId: 1,
        preset: 'pixel-11',
        orientation: 'portrait',
        fitToWindow: false,
        deviceShell: true,
        splitScreen: false,
      }),
    );
  });

  it('APP 模拟切换失败时使用现有 Toast 且不插入错误行', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string };
      if (request.action === 'quickAppProfileGet') return { success: true, profile: null };
      if (request.action === 'quickAppProfileSet') return { success: false, error: 'failed' };
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    const reader = within(appMenu).getByRole('menuitemradio', { name: '阅读器' });
    await waitFor(() => expect(reader).toBeEnabled());
    fireEvent.click(reader);

    await waitFor(() =>
      expect(toastMocks.showToast).toHaveBeenCalledWith('APP 模拟切换失败', 'error'),
    );
    expect(screen.queryByText('APP 模拟切换失败')).toBeNull();
  });

  it('在菜单选择设备，并通过主按钮按上次预设快速关闭和开启', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const deviceMenu = await screen.findByRole('menu', { name: '移动设备' });
    const iphone = within(deviceMenu).getByRole('menuitemradio', { name: 'iPhone 17 Pro' });
    fireEvent.click(iphone);

    await waitFor(() => expect(iphone).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('button', { name: 'iPhone 17 Pro' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceEmulationSet',
      tabId: 1,
      preset: 'iphone-17-pro',
      orientation: 'portrait',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
    expect(within(deviceMenu).queryByRole('menuitemradio', { name: '关闭' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'iPhone 17 Pro' }));

    const inactiveDeviceButton = await screen.findByRole('button', { name: 'iPhone 17 Pro' });
    expect(inactiveDeviceButton).toHaveAttribute('aria-pressed', 'false');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceEmulationClear',
      tabId: 1,
    });

    fireEvent.click(inactiveDeviceButton);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'iPhone 17 Pro' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
      action: 'quickDeviceEmulationSet',
      tabId: 1,
      preset: 'iphone-17-pro',
      orientation: 'portrait',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
  });

  it('选择 iPhone Duo 展开态时使用自然横屏视口', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const deviceMenu = await screen.findByRole('menu', { name: '移动设备' });
    const unfolded = within(deviceMenu).getByRole('menuitemradio', {
      name: 'iPhone Duo（展开）',
    });
    fireEvent.click(unfolded);

    await waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'quickDeviceEmulationSet',
          preset: 'iphone-duo-unfolded',
          orientation: 'landscape',
        }),
      ),
    );
  });

  it('分屏默认关闭，手动开启保留在当前设备且切换设备后关闭', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    fireEvent.click(within(appMenu).getByRole('menuitemradio', { name: '阅读器' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启横屏' }));
    const split = await screen.findByRole('button', { name: '分屏模拟' });
    expect(split).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(split);
    await waitFor(() => expect(split).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: '关闭横屏' }));
    fireEvent.click(await screen.findByRole('button', { name: '开启横屏' }));
    expect(await screen.findByRole('button', { name: '分屏模拟' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const deviceMenu = screen.getByRole('menu', { name: '移动设备' });
    fireEvent.click(within(deviceMenu).getByRole('menuitemradio', { name: 'iPhone Duo（展开）' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '分屏模拟' })).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );
  });

  it('端模拟开启时，自适应设备展示分屏按钮并在重新开启时默认关闭', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    const reader = within(appMenu).getByRole('menuitemradio', { name: '阅读器' });
    fireEvent.click(reader);
    await waitFor(() => expect(reader).toHaveAttribute('aria-checked', 'true'));

    const deviceMenu = await screen.findByRole('menu', { name: '移动设备' });
    const iosAdaptive = within(deviceMenu).getByRole('menuitemradio', {
      name: 'iOS（自适应）',
    });
    fireEvent.click(iosAdaptive);

    await waitFor(() => expect(iosAdaptive).toHaveAttribute('aria-checked', 'true'));
    const activeDeviceButton = screen.getByRole('button', { name: 'iOS（自适应）' });
    expect(activeDeviceButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: '适应窗口' })).toBeNull();
    expect(screen.queryByRole('button', { name: /横屏/ })).toBeNull();
    expect(screen.queryByTestId('device-fit-to-window-icon')).toBeNull();
    expect(screen.queryByTestId('device-landscape-toggle-icon')).toBeNull();
    const splitScreen = screen.getByRole('button', { name: '分屏模拟' });
    expect(splitScreen).toHaveAttribute('aria-pressed', 'false');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceEmulationSet',
      tabId: 1,
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
      splitScreen: false,
    });

    fireEvent.click(splitScreen);
    await waitFor(() => expect(splitScreen).toHaveAttribute('aria-pressed', 'true'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceSplitScreenSet',
      tabId: 1,
      splitScreen: true,
    });

    fireEvent.click(iosAdaptive);
    await waitFor(() => expect(iosAdaptive).toHaveAttribute('aria-checked', 'false'));
    expect(activeDeviceButton).toHaveAttribute('aria-pressed', 'false');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'quickDeviceEmulationClear',
      tabId: 1,
    });

    fireEvent.click(activeDeviceButton);
    await waitFor(() => expect(activeDeviceButton).toHaveAttribute('aria-pressed', 'true'));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
      action: 'quickDeviceEmulationSet',
      tabId: 1,
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
      splitScreen: false,
    });
  });

  it('从自适应设备切回固定设备时恢复固定设备偏好', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as {
        action?: string;
        preset?: 'ios-adaptive' | 'iphone-17-pro';
        orientation?: 'portrait' | 'landscape';
        fitToWindow?: boolean;
        deviceShell?: boolean;
        splitScreen?: boolean;
      };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: null, os: 'ios' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return {
          success: true,
          active: true,
          preset: 'iphone-17-pro',
          orientation: 'portrait',
          fitToWindow: true,
          deviceShell: true,
        };
      }
      if (request.action === 'quickSimulationAutoRuleGet') {
        return { success: true, enabled: false, domain: 'shop.com' };
      }
      if (request.action === 'quickDeviceEmulationSet') {
        return request.preset === 'ios-adaptive'
          ? {
              success: true,
              active: true,
              preset: request.preset,
              orientation: request.orientation,
              fitToWindow: false,
              fixedFitToWindow: true,
              deviceShell: request.deviceShell,
              splitScreen: request.splitScreen,
            }
          : {
              success: true,
              active: true,
              preset: request.preset,
              orientation: request.orientation,
              fitToWindow: request.fitToWindow,
              deviceShell: request.deviceShell,
              splitScreen: request.splitScreen,
            };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const deviceMenu = await screen.findByRole('menu', { name: '移动设备' });
    const iosAdaptive = within(deviceMenu).getByRole('menuitemradio', {
      name: 'iOS（自适应）',
    });
    const iphone = within(deviceMenu).getByRole('menuitemradio', { name: 'iPhone 17 Pro' });
    await waitFor(() => expect(iphone).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(iosAdaptive);
    await waitFor(() => expect(iosAdaptive).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(iphone);
    await waitFor(() => expect(iphone).toHaveAttribute('aria-checked', 'true'));

    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
      action: 'quickDeviceEmulationSet',
      tabId: 1,
      preset: 'iphone-17-pro',
      orientation: 'portrait',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
  });

  it('恢复当前标签页已生效的设备预设', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: null, os: 'ios' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return { success: true, active: true, preset: 'pixel-11' };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const deviceMenu = await screen.findByRole('menu', { name: '移动设备' });
    const pixel = within(deviceMenu).getByRole('menuitemradio', { name: 'Pixel 11' });
    await waitFor(() => expect(pixel).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('button', { name: 'Pixel 11' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('自定义 Agent 设备尺寸清除失败时保留状态并使用 Toast', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if ((message as { action?: string }).action === 'appProfileCatalogGet')
        return { success: true, profiles: listBuiltinAppProfiles() };
      const request = message as unknown as { action?: string };
      if (request.action === 'quickAppProfileGet') {
        return { success: true, profile: null, os: 'ios' };
      }
      if (request.action === 'quickDeviceEmulationGet') {
        return { success: true, active: true };
      }
      if (request.action === 'quickDeviceEmulationClear') {
        return { success: false, error: 'failed' };
      }
      return undefined;
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const custom = await screen.findByRole('button', { name: '自定义' });
    expect(custom).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /横屏/ })).toBeNull();
    fireEvent.click(custom);

    await waitFor(() =>
      expect(toastMocks.showToast).toHaveBeenCalledWith('设备模拟切换失败', 'error'),
    );
    expect(custom).toHaveAttribute('aria-pressed', 'true');
  });

  it('requests page permission before enabling App simulation', async () => {
    permissionPromptMocks.getPageHostPermissionGranted.mockResolvedValue(false);
    permissionPromptMocks.showHostPermissionPromptIfNeeded.mockResolvedValue(true);
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const appMenu = await screen.findByRole('menu', { name: '客户端' });
    const reader = within(appMenu).getByRole('menuitemradio', { name: '阅读器' });
    await waitFor(() => expect(reader).toBeEnabled());
    vi.mocked(chrome.runtime.sendMessage).mockClear();
    fireEvent.click(reader);

    await waitFor(() =>
      expect(permissionPromptMocks.showHostPermissionPromptIfNeeded).toHaveBeenCalledWith(1),
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('requests page permission before enabling device chrome', async () => {
    permissionPromptMocks.getPageHostPermissionGranted.mockResolvedValue(false);
    permissionPromptMocks.showHostPermissionPromptIfNeeded.mockResolvedValue(true);
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const deviceMenu = await screen.findByRole('menu', { name: '移动设备' });
    const pixel = within(deviceMenu).getByRole('menuitemradio', { name: 'Pixel 11' });
    await waitFor(() => expect(pixel).toBeEnabled());
    vi.mocked(chrome.runtime.sendMessage).mockClear();
    fireEvent.click(pixel);

    await waitFor(() =>
      expect(permissionPromptMocks.showHostPermissionPromptIfNeeded).toHaveBeenCalledWith(1),
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('reflects the floating entry visibility setting', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const toggle = await screen.findByRole('switch', { name: '侧边栏悬浮入口' });
    expect(toggle).toBeChecked();
  });

  it('updates the floating entry visibility instead of opening the side panel', async () => {
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const toggle = await screen.findByRole('switch', { name: '侧边栏悬浮入口' });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(configMocks.updateConfig).toHaveBeenCalledWith({
      agentFloatingButtonEnabled: false,
    });
    expect(permissionPromptMocks.showHostPermissionPromptIfNeeded).not.toHaveBeenCalled();
  });

  it('keeps the existing permission prompt when enabling on an unauthorized page', async () => {
    permissionPromptMocks.getPageHostPermissionGranted.mockResolvedValueOnce(false);
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const toggle = await screen.findByRole('switch', { name: '侧边栏悬浮入口' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(permissionPromptMocks.showHostPermissionPromptIfNeeded).toHaveBeenCalledWith(1),
    );
    expect(toggle).not.toBeChecked();
    expect(configMocks.updateConfig).not.toHaveBeenCalled();
  });

  it('enables the global setting before requesting permission when it was disabled', async () => {
    configMocks.getConfig.mockResolvedValueOnce({
      language: 'zh_CN',
      agentEnabled: true,
      agentFloatingButtonEnabled: false,
    });
    permissionPromptMocks.getPageHostPermissionGranted.mockResolvedValueOnce(false);
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);

    const toggle = await screen.findByRole('switch', { name: '侧边栏悬浮入口' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(configMocks.updateConfig).toHaveBeenCalledWith({
        agentFloatingButtonEnabled: true,
      }),
    );
    expect(permissionPromptMocks.showHostPermissionPromptIfNeeded).toHaveBeenCalledWith(1);
  });

  it('hides the setting when Agent service is disabled', async () => {
    configMocks.getConfig.mockResolvedValueOnce({
      language: 'zh_CN',
      agentEnabled: false,
      agentFloatingButtonEnabled: true,
    });
    render(<QuickSettingsMenu onShowSettings={vi.fn()} />);

    await waitFor(() => expect(configMocks.getConfig).toHaveBeenCalled());
    expect(screen.queryByRole('switch', { name: '侧边栏悬浮入口' })).toBeNull();
  });

  it.each(['客户端', '移动设备'])(
    'delays opening the %s selector on hover and focus',
    async name => {
      vi.useFakeTimers();
      try {
        render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
        await act(async () => {
          fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
          await vi.advanceTimersByTimeAsync(200);
        });
        const menu = screen.getByRole('menu', { name }).parentElement!;
        const selector = menu.parentElement!;
        const button = selector.querySelector('button')!;

        fireEvent.mouseEnter(selector);
        expect(menu).toHaveClass('opacity-0', 'pointer-events-none');
        act(() => vi.advanceTimersByTime(100));
        fireEvent.focus(button);
        act(() => vi.advanceTimersByTime(99));
        expect(menu).toHaveClass('opacity-0', 'pointer-events-none');
        act(() => vi.advanceTimersByTime(1));
        expect(menu).toHaveClass('opacity-100', 'pointer-events-auto');

        fireEvent.mouseLeave(selector);
        expect(menu).toHaveClass('opacity-100');
        fireEvent.blur(button, { relatedTarget: screen.getByTitle('settings') });
        act(() => vi.advanceTimersByTime(200));
        expect(menu).toHaveClass('opacity-0', 'pointer-events-none');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['客户端', '移动设备'])(
    'cancels opening the %s selector after a brief hover',
    async name => {
      vi.useFakeTimers();
      try {
        render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
        await act(async () => {
          fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
          await vi.advanceTimersByTimeAsync(200);
        });
        const menu = screen.getByRole('menu', { name }).parentElement!;
        const selector = menu.parentElement!;

        fireEvent.mouseEnter(selector);
        act(() => vi.advanceTimersByTime(199));
        fireEvent.mouseLeave(selector, {
          relatedTarget: screen.getByTitle('settings').parentElement,
        });
        act(() => vi.advanceTimersByTime(200));
        expect(menu).toHaveClass('opacity-0', 'pointer-events-none');

        fireEvent.mouseEnter(selector);
        act(() => vi.advanceTimersByTime(199));
        expect(menu).toHaveClass('opacity-0');
        act(() => vi.advanceTimersByTime(1));
        expect(menu).toHaveClass('opacity-100', 'pointer-events-auto');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ['客户端', '移动设备'],
    ['移动设备', '客户端'],
  ])('switches immediately from %s to %s across a pointer gap', async (from, to) => {
    vi.useFakeTimers();
    try {
      render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
      const trigger = screen.getByTitle('settings').parentElement!;
      await act(async () => {
        fireEvent.mouseEnter(trigger);
        await vi.advanceTimersByTimeAsync(200);
      });
      const firstMenu = screen.getByRole('menu', { name: from }).parentElement!;
      const nextMenu = screen.getByRole('menu', { name: to }).parentElement!;

      fireEvent.mouseEnter(firstMenu.parentElement!);
      act(() => vi.advanceTimersByTime(200));
      expect(firstMenu).toHaveClass('opacity-100');

      fireEvent.mouseLeave(firstMenu.parentElement!, { relatedTarget: trigger });
      act(() => vi.advanceTimersByTime(100));
      fireEvent.mouseEnter(nextMenu.parentElement!);
      expect(nextMenu).toHaveClass('opacity-100', 'pointer-events-auto');
      expect(firstMenu).toHaveClass('opacity-0', 'pointer-events-none');
      act(() => vi.advanceTimersByTime(200));
      expect(nextMenu).toHaveClass('opacity-100');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits again after leaving both selectors until they close', async () => {
    vi.useFakeTimers();
    try {
      render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
      const trigger = screen.getByTitle('settings').parentElement!;
      await act(async () => {
        fireEvent.mouseEnter(trigger);
        await vi.advanceTimersByTimeAsync(200);
      });
      const appMenu = screen.getByRole('menu', { name: '客户端' }).parentElement!;
      const deviceMenu = screen.getByRole('menu', { name: '移动设备' }).parentElement!;

      fireEvent.mouseEnter(appMenu.parentElement!);
      act(() => vi.advanceTimersByTime(200));
      fireEvent.mouseLeave(appMenu.parentElement!, { relatedTarget: trigger });
      act(() => vi.advanceTimersByTime(199));
      expect(appMenu).toHaveClass('opacity-100');
      act(() => vi.advanceTimersByTime(1));
      expect(appMenu).toHaveClass('opacity-0');

      fireEvent.mouseEnter(deviceMenu.parentElement!);
      act(() => vi.advanceTimersByTime(199));
      expect(deviceMenu).toHaveClass('opacity-0', 'pointer-events-none');
      act(() => vi.advanceTimersByTime(1));
      expect(deviceMenu).toHaveClass('opacity-100', 'pointer-events-auto');
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches selectors immediately with keyboard focus', async () => {
    vi.useFakeTimers();
    try {
      render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
      await act(async () => {
        fireEvent.mouseEnter(screen.getByTitle('settings').parentElement!);
        await vi.advanceTimersByTimeAsync(200);
      });
      const appMenu = screen.getByRole('menu', { name: '客户端' }).parentElement!;
      const deviceMenu = screen.getByRole('menu', { name: '移动设备' }).parentElement!;
      const appButton = appMenu.parentElement!.querySelector('button')!;
      const deviceButton = deviceMenu.parentElement!.querySelector('button')!;

      fireEvent.focus(appButton);
      act(() => vi.advanceTimersByTime(200));
      fireEvent.blur(appButton, { relatedTarget: deviceButton });
      fireEvent.focus(deviceButton, { relatedTarget: appButton });
      expect(appMenu).toHaveClass('opacity-0', 'pointer-events-none');
      expect(deviceMenu).toHaveClass('opacity-100', 'pointer-events-auto');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending selector opening when quick settings closes', async () => {
    vi.useFakeTimers();
    try {
      render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
      const trigger = screen.getByTitle('settings').parentElement!;
      await act(async () => {
        fireEvent.mouseEnter(trigger);
        await vi.advanceTimersByTimeAsync(200);
      });
      const menu = screen.getByRole('menu', { name: '移动设备' }).parentElement!;

      fireEvent.mouseEnter(menu.parentElement!);
      fireEvent.mouseLeave(trigger);
      act(() => vi.advanceTimersByTime(200));
      expect(menu).toHaveClass('opacity-0', 'pointer-events-none');

      fireEvent.mouseEnter(trigger);
      act(() => vi.advanceTimersByTime(200));
      expect(menu).toHaveClass('opacity-0', 'pointer-events-none');
    } finally {
      vi.useRealTimers();
    }
  });

  it('delays opening the quick settings panel on hover', async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
      const trigger = screen.getByTitle('settings').parentElement!;
      const menu = trigger.querySelector('[data-quick-settings-open]')!;

      await act(async () => {
        fireEvent.mouseEnter(trigger);
        await Promise.resolve();
      });
      expect(menu).toHaveAttribute('data-quick-settings-open', 'false');

      act(() => vi.advanceTimersByTime(199));
      expect(menu).toHaveAttribute('data-quick-settings-open', 'false');

      act(() => vi.advanceTimersByTime(1));
      expect(menu).toHaveAttribute('data-quick-settings-open', 'true');

      fireEvent.mouseLeave(trigger);
      expect(menu).toHaveAttribute('data-quick-settings-open', 'true');
      act(() => vi.advanceTimersByTime(200));
      expect(menu).toHaveAttribute('data-quick-settings-open', 'false');
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the quick settings panel open when the pointer enters it during close delay', async () => {
    vi.useFakeTimers();
    try {
      render(<QuickSettingsMenu onShowSettings={vi.fn()} />);
      const trigger = screen.getByTitle('settings').parentElement!;
      const menu = trigger.querySelector('[data-quick-settings-open]')!;

      fireEvent.mouseEnter(trigger);
      act(() => vi.advanceTimersByTime(200));
      expect(menu).toHaveAttribute('data-quick-settings-open', 'true');

      fireEvent.mouseLeave(trigger);
      act(() => vi.advanceTimersByTime(100));
      fireEvent.mouseEnter(menu);
      act(() => vi.advanceTimersByTime(100));

      expect(menu).toHaveAttribute('data-quick-settings-open', 'true');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the settings trigger hover-only and opens full settings from the menu entry', async () => {
    vi.useFakeTimers();
    try {
      const onShowSettings = vi.fn();
      render(<QuickSettingsMenu onShowSettings={onShowSettings} />);
      const settingsTrigger = screen.getByTitle('settings');
      const container = settingsTrigger.parentElement!;

      fireEvent.click(settingsTrigger);
      expect(onShowSettings).not.toHaveBeenCalled();

      fireEvent.mouseEnter(container);
      act(() => vi.advanceTimersByTime(200));
      fireEvent.click(screen.getByRole('button', { name: /moreSettings/ }));

      expect(onShowSettings).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
