import type { BrowserControlParams } from './browserActionProtocol.js';

/** External task lifecycle calls must not silently discard page retention options. */
export function parseExternalBrowserControl(value: unknown): BrowserControlParams {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid browser control request');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['operation', 'tabId', 'reason', 'keepTabIds'].includes(key)))
    throw new Error('Unsupported browser control parameter');
  if (
    typeof data.operation !== 'string' ||
    !['handoff', 'resume', 'finish'].includes(data.operation)
  )
    throw new Error('Invalid browser control operation');
  if (data.tabId !== undefined && (!Number.isSafeInteger(data.tabId) || Number(data.tabId) < 0))
    throw new Error('Invalid control tabId');
  if (data.reason !== undefined && typeof data.reason !== 'string')
    throw new Error('Invalid control reason');
  if (
    data.keepTabIds !== undefined &&
    (data.operation !== 'finish' ||
      !Array.isArray(data.keepTabIds) ||
      data.keepTabIds.some(id => !Number.isSafeInteger(id) || id < 0) ||
      new Set(data.keepTabIds).size !== data.keepTabIds.length)
  )
    throw new Error('keepTabIds requires finish and unique nonnegative integer tab IDs');
  return {
    operation: data.operation as BrowserControlParams['operation'],
    ...(data.tabId !== undefined ? { tabId: data.tabId as number } : {}),
    ...(data.reason !== undefined ? { reason: data.reason as string } : {}),
    ...(data.keepTabIds !== undefined ? { keepTabIds: [...(data.keepTabIds as number[])] } : {}),
  };
}
