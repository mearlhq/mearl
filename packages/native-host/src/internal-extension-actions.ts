import {
  isHostToExtensionAction,
  isPrivateExtensionServiceAction,
  toControlSourceWireValue,
  type ControlSource,
  type ControlSourceWireValue,
} from '@mearl/browser-core';

/** Browser clients cannot call either direction of the extension's private RPC. */
export function isPrivateExtensionAction(action: unknown): boolean {
  return isHostToExtensionAction(action) || isPrivateExtensionServiceAction(action);
}

export function createExtensionRequestMessage(
  id: string,
  action: string,
  data: any,
  trustedInternal = false,
  controlSource: ControlSource = 'local',
): {
  id: string;
  action: string;
  data: any;
  controlSource: ControlSourceWireValue;
  trustedInternal?: true;
} {
  return {
    id,
    action,
    data,
    controlSource: toControlSourceWireValue(controlSource),
    ...(trustedInternal ? { trustedInternal: true as const } : {}),
  };
}
