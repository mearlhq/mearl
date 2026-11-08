import type {
  ToolboxServiceAction,
  ToolboxServiceRequest,
  ToolboxServiceResponse,
  ToolboxTaskRequest,
  ToolboxTaskResponse,
  ExtensionUiServiceRequest,
} from '@mearl/browser-core';
import { requestExtensionService } from '../../shared/extensionServiceRequest';
export { nativeHostServiceUpdateInfo as toolboxNativeHostUpdateInfo } from '../../shared/extensionServiceRequest';

export function requestToolbox<R extends ToolboxTaskRequest>(
  action: 'toolbox_task',
  data: R,
): Promise<ToolboxTaskResponse<R>>;
export function requestToolbox<A extends Exclude<ToolboxServiceAction, 'toolbox_task'>>(
  action: A,
  ...args: ToolboxServiceRequest<A> extends undefined ? [] : [ToolboxServiceRequest<A>]
): Promise<ToolboxServiceResponse<A>>;
export function requestToolbox(action: ToolboxServiceAction, data?: unknown): Promise<unknown> {
  return requestExtensionService(action, data as ExtensionUiServiceRequest<typeof action>);
}
