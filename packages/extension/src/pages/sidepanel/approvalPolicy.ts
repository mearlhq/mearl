import type { AgentChatEvent } from '@mearl/browser-core';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasRequestedValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === '') return false;
  if (Array.isArray(value)) return value.some(hasRequestedValue);
  const values = record(value);
  return values ? Object.values(values).some(hasRequestedValue) : true;
}

function isMearlExecutable(value: unknown): boolean {
  return value === 'mearl' || value === 'mearl.cmd' || value === 'mearl.exe';
}

function isMearlArgv(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && isMearlExecutable(value[0]);
}

function isDirectMearlCommand(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const command = value.trim();
  if (/[;&|><`\r\n]/.test(command) || command.includes('$(')) return false;
  const executable = command.match(/^([^\s]+)/)?.[1];
  return isMearlExecutable(executable);
}

function isStructuredMearlCommand(params: Record<string, unknown>): boolean {
  if (!isMearlArgv(params.proposedExecpolicyAmendment)) return false;
  if (typeof params.command === 'string' && /`|\$\(/.test(params.command)) return false;

  const commandActions = params.commandActions;
  if (!Array.isArray(commandActions) || commandActions.length !== 1) return false;
  const action = record(commandActions[0]);
  return isDirectMearlCommand(action?.command) || isMearlArgv(action?.command);
}

export function isMearlCommandApproval(request: AgentChatEvent): boolean {
  if (
    request.method !== 'item/commandExecution/requestApproval' &&
    request.method !== 'execCommandApproval'
  ) {
    return false;
  }

  const params = record(request.params);
  if (!params) return false;
  if (
    hasRequestedValue(params.additionalPermissions) ||
    hasRequestedValue(params.proposedNetworkPolicyAmendments)
  ) {
    return false;
  }

  if (params.commandActions !== undefined || params.proposedExecpolicyAmendment !== undefined) {
    return isStructuredMearlCommand(params);
  }
  return isMearlArgv(params.command) || isDirectMearlCommand(params.command);
}
