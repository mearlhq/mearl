import type {
  BrowserReleaseParams,
  BrowserReleaseResult,
  ControlSource,
  PageDownloadParams,
  PageRecordingOptions,
} from '@mearl/browser-core';
import type { TransferableCookie } from '../browser-cookie-copy.js';
import type { OpenRecording } from '../page-recordings.js';

/** Browser operations served in-process by a Native Host transport. */
export interface HostBrowserProvider {
  readonly browserId: string;
  invoke(action: string, data: any, controlSource: ControlSource, deadline?: number): Promise<any>;
  deactivate?(tabIds: number[]): Promise<void>;
  cleanup(
    tabIds: number[],
    preserveEnvironment: boolean,
    returningToAgent?: boolean,
  ): Promise<void>;
  download(
    data: PageDownloadParams,
    source: ControlSource,
  ): Promise<{
    filename: string;
    filePath: string;
    action: unknown;
    owned?: boolean;
    directory?: string;
  }>;
  openRecording(
    tabId: number,
    recordingId: string,
    options: Required<PageRecordingOptions>,
  ): ReturnType<OpenRecording>;
  release(
    data: BrowserReleaseParams,
  ): Promise<Omit<BrowserReleaseResult, 'transports'> | undefined>;
  exportCookies(domains: string[]): Promise<TransferableCookie[]>;
  dispose(): void;
}
