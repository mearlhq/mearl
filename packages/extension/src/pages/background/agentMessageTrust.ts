const SAFE_INTERNAL_ACTIONS = new Set(['__extension_reload', '__toolbox_open']);

export function isAgentActionAllowedByInternalBoundary(
  action: string,
  trustedInternal?: boolean,
): boolean {
  if (!action.startsWith('__')) return true;
  return trustedInternal === true || SAFE_INTERNAL_ACTIONS.has(action);
}
