import { limitBufferedField } from '@mearl/browser-core';
import {
  DEVICE_PREVIEW_PANEL_PAGE,
  DEVICE_PREVIEW_PANEL_PORT,
  DEVICE_PREVIEW_PANEL_READY_ACTION,
  PANEL_PRESERVE_LOG_KEY,
  type DevicePreviewLayout,
  type DevicePreviewPanelMessage,
} from '../../shared/devicePreviewPanel';
import type { CapturedRequest, NavigationDivider, RumEvent } from '../panel/types';
import { appendNavigationDivider } from '../panel/utils/navigationDividers';
import { waitForQuickSimulationUpdate } from './quickSimulationUpdateQueue';
import {
  getCollectorSnapshot,
  startRequestCollection,
  stopRequestCollection,
  type CollectorUpdate,
} from './backgroundRequestCollector';

const consumer = 'device-preview-panel';
const panels = new Map<number, PreviewPanel>();
const closing = new Map<number, Promise<void>>();
const panelVisibility = new Map<number, NonNullable<DevicePreviewLayout['panel']>>();

interface PreviewPanel {
  token: string;
  since: number;
  status: 'connecting' | 'capturing' | 'error';
  port?: chrome.runtime.Port;
  navigation: NavigationDivider[];
}

function post(panel: PreviewPanel, message: DevicePreviewPanelMessage): void {
  try {
    panel.port?.postMessage(message);
  } catch {
    // The iframe can disconnect during navigation before its replacement subscribes.
  }
}

function previewEvent(event: RumEvent): RumEvent {
  const raw = limitBufferedField(event._raw, 24_000);
  const context = limitBufferedField(event._context, 24_000);
  return {
    ...event,
    _raw: typeof raw === 'string' ? { preview: raw } : raw,
    _context: typeof context === 'string'
      ? { requestUrl: event._context.requestUrl, app: {}, user: {}, session: {}, view: {}, properties: { preview: context }, os: {}, net: {} }
      : context,
  };
}

function isPreviewRequest(request: CapturedRequest, panel: PreviewPanel): boolean {
  return request.timestampMs >= panel.since;
}

function sendSnapshot(tabId: number, panel: PreviewPanel): void {
  const { requests, events } = getCollectorSnapshot(tabId);
  post(panel, {
    type: 'snapshot',
    requests: requests.filter(request => isPreviewRequest(request, panel)),
    events: events.filter(event => event.batchTimestampMs >= panel.since).map(previewEvent),
    navigation: panel.navigation,
  });
}

async function start(tabId: number, panel: PreviewPanel): Promise<void> {
  panel.status = 'connecting';
  post(panel, { type: 'state', state: panel.status, tabId });
  try {
    await closing.get(tabId);
    await waitForQuickSimulationUpdate(tabId);
    if (panels.get(tabId) !== panel) return;
    await startRequestCollection(tabId, consumer);
    if (panels.get(tabId) !== panel) return;
    if (panel.status === 'connecting') {
      panel.status = 'capturing';
      sendSnapshot(tabId, panel);
    }
  } catch {
    panel.status = 'error';
  }
  post(panel, { type: 'state', state: panel.status, tabId });
}

export function getDevicePreviewPanelVisibility(tabId: number) {
  return panelVisibility.get(tabId);
}

export function getDevicePreviewPanelToken(tabId: number, open?: boolean, wide?: boolean, retryCapture = false): string | null {
  if (open === false) {
    closeDevicePreviewPanel(tabId);
    if (wide !== undefined) panelVisibility.set(tabId, { wide, open });
    return null;
  }
  if (open && wide !== undefined) panelVisibility.set(tabId, { wide, open });
  const existing = panels.get(tabId);
  if (existing) {
    if (open && retryCapture && existing.status === 'error') void start(tabId, existing);
    return existing.token;
  }
  if (!open) return null;
  const panel: PreviewPanel = { token: crypto.randomUUID(), since: Date.now(), status: 'connecting', navigation: [] };
  panels.set(tabId, panel);
  void start(tabId, panel);
  return panel.token;
}

export function closeDevicePreviewPanel(tabId: number): void {
  panelVisibility.delete(tabId);
  const panel = panels.get(tabId);
  if (!panel) return;
  panels.delete(tabId);
  panel.port?.disconnect();
  const release = stopRequestCollection(tabId, consumer).catch(() => {});
  closing.set(tabId, release);
  void release.then(() => {
    if (closing.get(tabId) === release) closing.delete(tabId);
  });
}

export function connectDevicePreviewPanel(port: chrome.runtime.Port): boolean {
  if (!port.name.startsWith(DEVICE_PREVIEW_PANEL_PORT)) return false;
  const sender = port.sender;
  const tabId = sender?.tab?.id;
  const panel = tabId === undefined ? undefined : panels.get(tabId);
  if (tabId === undefined || !panel || sender?.id !== chrome.runtime.id || !sender.frameId ||
      sender.url?.split(/[?#]/, 1)[0] !== chrome.runtime.getURL(DEVICE_PREVIEW_PANEL_PAGE) ||
      port.name !== DEVICE_PREVIEW_PANEL_PORT + panel.token) {
    port.disconnect();
    return true;
  }
  const viewer = new URL(sender.url).searchParams.get('viewer');
  panel.port?.disconnect();
  panel.port = port;
  port.onDisconnect.addListener(() => {
    if (panel.port === port) panel.port = undefined;
  });
  port.onMessage.addListener(message => {
    if (panel.port !== port) return;
    if (message === 'retry' && panel.status === 'error') void start(tabId, panel);
    if (message === 'clear') clear(panel, Date.now());
    if (message === 'ready' && viewer) {
      void chrome.tabs.sendMessage(tabId, { action: DEVICE_PREVIEW_PANEL_READY_ACTION, viewer }, { frameId: 0 }).catch(() => {});
    }
  });
  post(panel, { type: 'state', state: panel.status, tabId });
  if (panel.status === 'capturing') sendSnapshot(tabId, panel);
  return true;
}

function clear(panel: PreviewPanel, timestamp: number): void {
  panel.since = Math.max(panel.since, timestamp);
  panel.navigation = [];
  post(panel, { type: 'snapshot', requests: [], events: [], navigation: [] });
}

export async function navigateDevicePreviewPanel(tabId: number, timestamp: number, url: string): Promise<void> {
  const panel = panels.get(tabId);
  if (!panel) return;
  const stored = await chrome.storage.local.get(PANEL_PRESERVE_LOG_KEY).catch(() => ({}));
  if (panels.get(tabId) !== panel || timestamp < panel.since) return;
  if (PANEL_PRESERVE_LOG_KEY in stored && stored[PANEL_PRESERVE_LOG_KEY] === true) {
    panel.navigation = appendNavigationDivider(panel.navigation, url, timestamp);
  } else {
    panel.since = timestamp;
    panel.navigation = [];
  }
  sendSnapshot(tabId, panel);
}

export function interruptDevicePreviewPanel(tabId: number): void {
  const panel = panels.get(tabId);
  if (!panel) return;
  panel.status = 'error';
  post(panel, { type: 'state', state: panel.status, tabId });
}

export function notifyDevicePreviewPanel(tabId: number, message: Record<string, unknown>): void {
  const panel = panels.get(tabId);
  if (panel) post(panel, { type: 'notification', message });
}

export function updateDevicePreviewPanel(tabId: number, update: CollectorUpdate): void {
  const panel = panels.get(tabId);
  if (!panel?.port || panel.status !== 'capturing') return;
  if (update.type === 'request') {
    const request = isPreviewRequest(update.request, panel) && !update.removedRequestIds.includes(update.request.id)
      ? update.request
      : undefined;
    post(panel, { type: 'request', request, removed: update.removedRequestIds });
  } else {
    const events = update.events.filter(event => event.batchTimestampMs >= panel.since).map(previewEvent);
    post(panel, { type: 'events', events, removed: update.removedEventIds });
  }
}
