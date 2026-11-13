import type { CapturedRequest, RumEvent } from '@mearl/browser-core';
import type { NavigationDivider } from '../pages/panel/types';
import type { QuickDeviceToolbarSelection } from './quickDeviceToolbar';

export const DEVICE_PREVIEW_PANEL_PAGE = 'src/pages/device-preview-panel/index.html';
export const DEVICE_PREVIEW_PANEL_PORT = 'device-preview-panel:';
export const DEVICE_PREVIEW_PANEL_STATE_ACTION = 'devicePreviewPanelState';
export const DEVICE_PREVIEW_PANEL_READY_ACTION = 'devicePreviewPanelReady';
export const DEVICE_PREVIEW_PANEL_WIDTH = 'device-preview-panel-width';
export const DEVICE_PREVIEW_PANEL_OPEN = 'device-preview-panel-open';
export const DEVICE_PREVIEW_TOOLBAR_COLLAPSED = 'device-preview-toolbar-collapsed';

export interface DevicePreviewLayout {
  width?: number;
  toolbarCollapsed?: boolean;
  panelOpen?: boolean;
  viewport?: { width: number; height: number };
  toolbar?: QuickDeviceToolbarSelection;
}

export type DevicePreviewPanelMessage =
  | { type: 'state'; state: 'connecting' | 'capturing' | 'error'; tabId: number }
  | {
      type: 'snapshot';
      requests: CapturedRequest[];
      events: RumEvent[];
      navigation: NavigationDivider[];
    }
  | { type: 'request'; request?: CapturedRequest; removed: number[] }
  | { type: 'events'; events: RumEvent[]; removed: string[] }
  | { type: 'notification'; message: Record<string, unknown> };

export const PANEL_PRESERVE_LOG_KEY = 'panel-preserve-log';
