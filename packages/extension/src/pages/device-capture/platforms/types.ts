import { CapturedRequest, ResponseOverride } from '../../panel/types';

export type PlatformId = string;

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';
export type UpstreamStatus = 'idle' | 'waiting' | 'active';

export interface StatusText {
  connecting: string;
  active: string;
  idle: string;
}

export interface ConnectionState {
  status: ConnectionStatus;
  upstream: UpstreamStatus;
  errorMessage?: string;
  statusText: StatusText;
  reconnect: () => void;
  disconnect: () => void;
}

export interface ConnectionHookOptions {
  enabled: boolean;
  onMessage: (req: CapturedRequest) => void;
}

export interface ModifyApi {
  apiOverrides: Map<string, ResponseOverride>;
  prepareOverride?: (request: CapturedRequest) => Promise<void>;
  onRequest?: (req: CapturedRequest) => void;
  setOverride: (req: CapturedRequest, modifiedData: any) => Promise<void>;
  removeOverride: (req: CapturedRequest) => Promise<void>;
  removeAllOverrides: () => Promise<void>;
  /** 真机上已生效的 mock 接口列表 */
  onlineMocks?: string[];
  /** 拉取真机上已生效的 mock 接口列表 */
  refreshOnlineMocks?: () => Promise<void>;
  /** 清除真机上某个已生效的 mock 接口 */
  cleanOnlineMock?: (apiUrl: string) => Promise<void>;
}
