import { readToolboxClipboard, writeToolboxClipboardImage } from './toolboxClipboard';
import { requestNativeHost } from '../sidepanel/nativeHostRequest';
import { requestToolbox } from '../popup/toolboxRequest';
import { showToast, type ToastType } from '../panel/utils/toast';
import { isPluginTaskId } from '@mearl/browser-core';

export async function invokeToolboxHostCapability(
  toolId: string,
  capability: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (capability.startsWith('host.model.')) {
    const operation = capability.slice('host.model.'.length);
    if (!['capabilities', 'list', 'start'].includes(operation))
      throw new Error('Invalid model host operation');
    return requestToolbox('toolbox_model', { id: toolId, operation, input });
  }
  if (capability.startsWith('host.page.') || capability.startsWith('host.state.')) {
    const state = capability.startsWith('host.state.');
    const action = state ? 'toolbox_state' : 'toolbox_page';
    const requestedOperation = capability.slice(state ? 'host.state.'.length : 'host.page.'.length);
    const operation = state && requestedOperation === 'getMany' ? 'get-many' : requestedOperation;
    if (
      !(
        state
          ? ['get', 'get-many', 'list', 'transact']
          : ['attach', 'get', 'list', 'send', 'detach', 'events', 'activation']
      ).includes(operation)
    )
      throw new Error('Invalid page host operation');
    const result = (await requestToolbox(action, { id: toolId, operation, input })) as any;
    if (result?.kind === 'value') return result.value;
    if (
      result?.kind !== 'resource' ||
      !Number.isSafeInteger(result.bytes) ||
      result.bytes < 1 ||
      result.bytes > 24 * 1024 * 1024 ||
      result.chunks !== Math.ceil(result.bytes / (192 * 1024))
    )
      throw new Error('Invalid plugin page reply');
    try {
      const bytes = new Uint8Array(result.bytes);
      let offset = 0;
      for (let index = 0; index < result.chunks; index++) {
        const chunk = (await requestToolbox(action, {
          id: toolId,
          operation: 'result_chunk',
          input: { resultId: result.resultId, index },
        })) as any;
        if (
          chunk.resultId !== result.resultId ||
          chunk.index !== index ||
          chunk.bytes !== result.bytes ||
          chunk.sha256 !== result.sha256 ||
          chunk.chunks !== result.chunks
        )
          throw new Error('Plugin page reply identity mismatch');
        const part = Uint8Array.from(atob(chunk.data), value => value.charCodeAt(0));
        bytes.set(part, offset);
        offset += part.length;
      }
      const sha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        value => value.toString(16).padStart(2, '0'),
      ).join('');
      if (offset !== result.bytes || sha256 !== result.sha256)
        throw new Error('Plugin page reply integrity check failed');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally {
      await requestToolbox(action, {
        id: toolId,
        operation: 'result_release',
        input: { resultId: result.resultId },
      }).catch(() => {});
    }
  }
  switch (capability) {
    case 'host.tab.active': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id !== undefined && /^https?:\/\//.test(tab.url ?? '')
        ? { tabId: tab.id, title: tab.title ?? '', url: tab.url }
        : null;
    }
    case 'host.clipboard.read':
      return readToolboxClipboard();
    case 'host.clipboard.writeText': {
      if (typeof input.text !== 'string' || input.text.length > 1000000)
        throw new Error('Clipboard text must fit within 1000000 characters');
      await navigator.clipboard.writeText(input.text);
      return null;
    }
    case 'host.clipboard.writeImage':
      await writeToolboxClipboardImage(input.data);
      return null;
    case 'host.directory.select': {
      const response = await requestNativeHost('agent_chat_pick_directory');
      return response.path;
    }
    case 'host.link.open': {
      if (typeof input.url !== 'string' || !input.url || input.url.length > 8192)
        throw new Error('External link must fit within 8192 characters');
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('External link must use HTTP or HTTPS without embedded credentials');
      await chrome.tabs.create({ url: url.href, active: true });
      return null;
    }
    case 'host.toast': {
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000)
        throw new Error('Toast message must be non-empty and fit within 4000 characters');
      const type = input.type ?? 'info',
        duration = input.duration ?? 3000;
      if (!['success', 'error', 'info'].includes(type as string))
        throw new Error('Invalid toast type');
      if (
        typeof duration !== 'number' ||
        !Number.isInteger(duration) ||
        duration < 1000 ||
        duration > 30000
      )
        throw new Error('Toast duration must be between 1000 and 30000 milliseconds');
      showToast(input.message.trim(), type as ToastType, duration);
      return null;
    }
    case 'host.task.diagnose': {
      if (
        Object.keys(input).some(
          key =>
            !['taskId', 'instanceId', 'includeErrorMessages', 'includeLocalPaths'].includes(key),
        )
      )
        throw new Error('Invalid diagnostic options');
      return requestToolbox('toolbox_task', { operation: 'diagnose', id: toolId, ...input });
    }
    case 'host.task.start': {
      if (typeof input.command !== 'string' || !/^[a-z][a-z0-9-]*$/.test(input.command))
        throw new Error('Invalid plugin command');
      if (
        input.input !== undefined &&
        (!input.input || typeof input.input !== 'object' || Array.isArray(input.input))
      )
        throw new Error('Plugin input must be an object');
      return requestToolbox('toolbox_task', {
        operation: 'start',
        id: toolId,
        command: input.command,
        input: (input.input ?? {}) as Record<string, unknown>,
        ...(input.executionTimeoutMs !== undefined
          ? { executionTimeoutMs: input.executionTimeoutMs as number }
          : {}),
        ...(input.idempotencyKey !== undefined
          ? { idempotencyKey: input.idempotencyKey as string }
          : {}),
      });
    }
    case 'host.task.get':
    case 'host.task.cancel': {
      if (!isPluginTaskId(input.taskId)) throw new Error('Invalid plugin task id');
      return requestToolbox('toolbox_task', {
        operation: capability === 'host.task.get' ? 'get' : 'cancel',
        id: toolId,
        taskId: input.taskId,
      });
    }
    case 'host.task.list': {
      if (input.cursor !== undefined && typeof input.cursor !== 'string')
        throw new Error('Invalid task list cursor');
      if (
        input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 200)
      )
        throw new Error('Invalid task list limit');
      return requestToolbox('toolbox_task', {
        operation: 'list',
        id: toolId,
        ...(input.activeOnly !== undefined ? { activeOnly: input.activeOnly !== false } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
      });
    }
    case 'host.task.events': {
      if (!isPluginTaskId(input.taskId)) throw new Error('Invalid plugin task id');
      if (
        input.cursor !== undefined &&
        (!Number.isSafeInteger(input.cursor) || Number(input.cursor) < 0)
      )
        throw new Error('Invalid task event cursor');
      if (
        input.waitMs !== undefined &&
        (!Number.isSafeInteger(input.waitMs) ||
          Number(input.waitMs) < 0 ||
          Number(input.waitMs) > 25000)
      )
        throw new Error('Invalid task event wait');
      return requestToolbox('toolbox_task', {
        operation: 'events',
        id: toolId,
        taskId: input.taskId,
        cursor: Number(input.cursor ?? 0),
        waitMs: Number(input.waitMs ?? 0),
      });
    }
    case 'host.task.result': {
      if (
        !isPluginTaskId(input.taskId) ||
        !Number.isSafeInteger(input.index) ||
        Number(input.index) < 0
      )
        throw new Error('Invalid task result chunk');
      return requestToolbox('toolbox_task', {
        operation: 'result',
        id: toolId,
        taskId: input.taskId,
        index: Number(input.index),
      });
    }
    default:
      throw new Error(`Unknown toolbox host capability: ${capability}`);
  }
}
