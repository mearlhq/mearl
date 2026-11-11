import { resolveInstalledAppProfile } from '../app-profile-catalog.js';
/**
 * CDP tab management handlers.
 */

import {
  captureCheckpoint,
  resolveEmulationConfig,
  buildEnableEmulationCommands,
  selectMatchingTab,
  type CaptureCheckpointResult,
  type ControlSource,
  type TabCloseParams,
  type TabOpenParams,
} from '@mearl/browser-core';
import type { TabMatchCandidate } from '@mearl/browser-core';
import { isImplicitlySelectablePageUrl, type CdpSession, type PageSession } from './cdp-session.js';
import { CdpPageLoadTimeoutError, waitForPageLoad } from './cdp-utils.js';
import { assertBrowserRequestDeadline } from '../control-session.js';
import { registerActions } from './action-registry.js';
import { ensureControlledIndicator } from './controlled-indicator.js';
import {
  applyResolvedCdpAppProfile,
  resolveCdpAppProfile,
  waitForCdpAppProfileLoad,
} from './app-profile-handlers.js';
import { applyCdpDeviceShell, waitForCdpDeviceShellLoad } from './device-shell.js';
import { watchCdpWebMcp } from './webmcp-handlers.js';

interface CdpPageTarget extends TabMatchCandidate {
  targetId: string;
  url: string;
  title?: string;
  type: string;
}

interface CdpTabActivationResult {
  requested: true;
  tabActive: true;
  windowRestored?: boolean;
  windowState?: string;
  visibilityState?: string;
}

type TabNavigation =
  { status: 'ready' | 'loading' | 'pending' } | { status: 'failed'; error: string };

async function activateCdpTarget(
  browserClient: { sendCommand(method: string, params?: Record<string, unknown>): Promise<any> },
  targetId: string,
): Promise<CdpTabActivationResult> {
  let windowRestored = false;
  let windowState: string | undefined;
  try {
    const windowInfo = await browserClient.sendCommand('Browser.getWindowForTarget', { targetId });
    windowState = windowInfo?.bounds?.windowState;
    if (typeof windowInfo?.windowId === 'number' && windowState === 'minimized') {
      await browserClient.sendCommand('Browser.setWindowBounds', {
        windowId: windowInfo.windowId,
        bounds: { windowState: 'normal' },
      });
      windowRestored = true;
      windowState = 'normal';
    }
  } catch {
    // Some external CDP providers do not expose the Browser window APIs.
  }
  await browserClient.sendCommand('Target.activateTarget', { targetId });
  return {
    requested: true,
    tabActive: true,
    ...(windowRestored ? { windowRestored } : {}),
    ...(windowState ? { windowState } : {}),
  };
}

async function readCdpVisibilityState(pageSession: PageSession): Promise<string | undefined> {
  try {
    const result = await pageSession.client.sendCommand('Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true,
    });
    return typeof result.result?.value === 'string' ? result.result.value : undefined;
  } catch {
    return undefined;
  }
}

function currentCapture(pageSession: PageSession): CaptureCheckpointResult {
  return {
    tabId: pageSession.tabId,
    cursor: captureCheckpoint(pageSession.buffers.capture),
    timestampMs: Date.now(),
    captureStatus: pageSession.buffers.capture.currentSequence === 0 ? 'armed' : 'active',
  };
}

export async function cdpTabOpen(
  session: CdpSession,
  data: TabOpenParams,
  controlSource: ControlSource = 'local',
  deadline?: number,
): Promise<any> {
  // group（标签页分组）仅扩展模式支持：CDP 没有 tab group API，此处忽略
  const { url, active = false, emulation, reuse = 'never', match, appProfile } = data;

  if (!url || typeof url !== 'string') {
    throw new Error('Invalid url: url must be a non-empty string');
  }
  if (!['never', 'prefer', 'require'].includes(reuse)) {
    throw new Error('Invalid reuse: expected "never", "prefer", or "require"');
  }
  if (data.os !== undefined && data.os !== 'ios' && data.os !== 'android') {
    throw new Error('Invalid os: expected "ios" or "android"');
  }
  if (data.os !== undefined && !appProfile) {
    throw new Error('tab_open os requires appProfile.');
  }
  if (data.bridgeConfig !== undefined && !appProfile) {
    throw new Error('tab_open bridgeConfig requires appProfile.');
  }

  // 档案名和设备参数在创建 target 前解析，错误输入不会留下空白标签页。
  const installed = appProfile ? await resolveInstalledAppProfile(appProfile) : undefined;
  const resolvedProfile = appProfile
    ? resolveCdpAppProfile(
        appProfile,
        {
          os: data.os,
          devicePreset: emulation?.preset,
          orientation: emulation?.orientation,
          bridgeConfig: data.bridgeConfig,
        },
        installed?.injected.binding?.definition,
      )
    : undefined;
  const emulationConfig = emulation
    ? resolveEmulationConfig({ ...emulation, enabled: true })
    : undefined;
  const splitScreen =
    emulation?.deviceShell === true &&
    emulation?.splitScreen === true &&
    emulationConfig?.orientation === 'landscape' &&
    Boolean(resolvedProfile);

  const browserClient = await session.getBrowserClient();

  if (reuse !== 'never') {
    const targets = await browserClient.sendCommand('Target.getTargets');
    const pages = (targets.targetInfos ?? []).filter(
      (target: any) => target.type === 'page',
    ) as CdpPageTarget[];
    const blocked = new Set((data as any).__mearlBlockedTabIds ?? []);
    const available = [];
    for (const page of pages) {
      const tabId = await session.ensureTargetRegistered(page.targetId);
      if (!blocked.has(tabId)) available.push(page);
    }
    const existing = selectMatchingTab(available, url, match);
    if (existing) {
      if (emulation || appProfile) {
        throw new Error(
          'tab_open cannot apply pre-navigation emulation or appProfile to a reused tab.',
        );
      }
      assertBrowserRequestDeadline(deadline);
      const activation = active
        ? await activateCdpTarget(browserClient, existing.targetId)
        : undefined;
      const tabId = await session.ensureTargetRegistered(existing.targetId);
      const pageSession = await session.getPageSession(tabId);
      const webmcp = watchCdpWebMcp(pageSession);
      void webmcp.refreshCatalog();
      if (activation) {
        const visibilityState = await readCdpVisibilityState(pageSession);
        if (visibilityState) activation.visibilityState = visibilityState;
      }
      await ensureControlledIndicator(pageSession, controlSource);
      const capture = currentCapture(pageSession);
      return {
        tabId,
        url: existing.url ?? url,
        title: existing.title ?? '',
        opened: false,
        reused: true,
        capture,
        ...webmcp.fields(existing.url ?? url),
        ...(activation ? { activation } : {}),
      };
    }
    if (reuse === 'require') {
      throw new Error('tab_open did not find a matching existing tab and reuse is "require".');
    }
  }

  // 先建空白 tab 并下发 emulation，再导航到目标 URL，确保首个请求和首屏均为移动态。
  assertBrowserRequestDeadline(deadline);
  const result = await browserClient.sendCommand('Target.createTarget', {
    url: 'about:blank',
    background: !active,
  });

  const targetId: string = result.targetId;
  const activation = active ? await activateCdpTarget(browserClient, targetId) : undefined;
  const tabId = await session.registerTarget(targetId);

  // registerTarget 已创建并附加 page session
  const pageSession = await session.getPageSession(tabId);
  const webmcp = watchCdpWebMcp(pageSession);

  // 导航前注册受控标识，首屏文档即带 Mearl favicon
  await ensureControlledIndicator(pageSession, controlSource);
  const capture = currentCapture(pageSession);

  if (emulationConfig) {
    for (const { method, params, optional } of buildEnableEmulationCommands(emulationConfig)) {
      await pageSession.client.sendCommand(method, params).catch(error => {
        if (!optional) throw error;
      });
    }
    pageSession.emulation = {
      mobile: emulationConfig.mobile,
      touch: emulationConfig.touch,
      config: emulationConfig,
      deviceShell: emulation?.deviceShell === true,
      splitScreen,
    };
    if (emulation?.deviceShell) {
      await applyCdpDeviceShell(pageSession, emulationConfig, {
        rootContainerManagedByApp: splitScreen,
      });
    }
  }
  if (resolvedProfile) await applyResolvedCdpAppProfile(pageSession, resolvedProfile);

  try {
    assertBrowserRequestDeadline(deadline);
  } catch (error) {
    // The caller will not receive this newly created blank tab.
    await browserClient.sendCommand('Target.closeTarget', { targetId }, 1000).catch(() => {});
    throw error;
  }
  const navigationDeadline = Math.min(Date.now() + 30_000, deadline ?? Infinity);
  const remaining = () => Math.max(1, navigationDeadline - Date.now());
  let navigation: TabNavigation = { status: 'ready' };
  try {
    const result = await pageSession.client.sendCommand('Page.navigate', { url }, remaining());
    if (result.errorText) navigation = { status: 'failed', error: result.errorText };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'CDP command timeout: Page.navigate')
      throw error;
    // Chrome may still commit the navigation after the acknowledgement times out.
    navigation = { status: 'pending' };
  }
  if (navigation.status === 'ready') {
    try {
      if (emulation?.deviceShell) await waitForCdpDeviceShellLoad(pageSession);
      else if (resolvedProfile) await waitForCdpAppProfileLoad(pageSession);
      else await waitForPageLoad(pageSession, remaining(), { waitUntil: 'domcontentloaded' });
    } catch (error) {
      if (!(error instanceof CdpPageLoadTimeoutError)) throw error;
      navigation = { status: 'loading' };
    }
  }
  const targetInfo = await browserClient
    .sendCommand('Target.getTargetInfo', { targetId }, 1000)
    .then(result => result.targetInfo)
    .catch(() => null);
  const openedUrl = targetInfo?.url ?? url;
  if (navigation.status === 'ready') void webmcp.refreshCatalog();
  if (activation && navigation.status === 'ready') {
    const visibilityState = await readCdpVisibilityState(pageSession);
    if (visibilityState) activation.visibilityState = visibilityState;
  }

  return {
    tabId,
    url: openedUrl,
    title: targetInfo?.title ?? '',
    opened: true,
    reused: false,
    navigation: { requestedUrl: url, ...navigation },
    capture,
    ...webmcp.fields(openedUrl),
    ...(activation ? { activation } : {}),
    ...(!isImplicitlySelectablePageUrl(openedUrl) && {
      note: 'This URL is excluded from implicit CDP target selection. Pass this tabId to subsequent page actions.',
    }),
    ...(emulationConfig && {
      emulation: {
        preset: emulationConfig.presetName,
        viewport: {
          width: emulationConfig.width,
          height: emulationConfig.height,
          deviceScaleFactor: emulationConfig.deviceScaleFactor,
          scale: emulationConfig.scale ?? 1,
        },
        userAgent: emulationConfig.userAgent,
        mobile: emulationConfig.mobile,
        touch: emulationConfig.touch,
        orientation: emulationConfig.orientation,
        deviceShell: emulation?.deviceShell === true,
        splitScreen,
      },
    }),
    ...(resolvedProfile && {
      appProfile: {
        profile: resolvedProfile.profile.profile,
        label: resolvedProfile.profile.label,
        userAgent: resolvedProfile.profile.ua,
        os: resolvedProfile.profile.injected.platform === 'Android' ? 'android' : 'ios',
      },
    }),
  };
}

export async function cdpTabClose(session: CdpSession, data: TabCloseParams): Promise<any> {
  const { tabId } = data;
  if (typeof tabId !== 'number') {
    throw new Error('Invalid tabId: tabId must be a number');
  }

  const browserClient = await session.getBrowserClient();
  const pageSession = await session.getPageSession(tabId);
  await browserClient.sendCommand('Target.closeTarget', { targetId: pageSession.targetId });

  return { success: true };
}

export async function cdpTabList(session: CdpSession, _data: any): Promise<any> {
  const browserClient = await session.getBrowserClient();
  const result = await browserClient.sendCommand('Target.getTargets');

  const pages = (result.targetInfos ?? []).filter(
    (t: any) => t.type === 'page' && isImplicitlySelectablePageUrl(t.url),
  );
  const tabs = await Promise.all(
    pages.map(async (t: any) => {
      const tabId = await session.ensureTargetRegistered(t.targetId);
      return {
        id: tabId,
        tabId,
        url: t.url,
        title: t.title ?? '',
        active: false,
      };
    }),
  );

  return { tabs, count: tabs.length };
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerActions([
  { name: 'tab_open', session: 'browser', handler: cdpTabOpen },
  { name: 'tab_close', session: 'browser', handler: cdpTabClose },
  { name: 'tab_list', session: 'browser', handler: cdpTabList },
]);
