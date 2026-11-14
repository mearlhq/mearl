import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  getSendRequestBodyFile,
  type RunActionsParams,
  type SendRequestParams,
} from '@mearl/browser-core';
import {
  resolveSendRequestFiles,
  type ResolvedSendRequestFile,
} from './send-request-file-utils.js';

const FILE_CHUNK_BYTES = 256 * 1024;
const TRANSFER_ACTION_TIMEOUT_MS = 15000;

type SendExtensionTransferAction = (action: string, data: any, timeoutMs: number) => Promise<any>;

async function sendFileChunks(
  transferId: string,
  fileIndex: number,
  file: ResolvedSendRequestFile,
  send: SendExtensionTransferAction,
): Promise<void> {
  let chunkIndex = 0;
  const sendChunk = async (chunk: Buffer) => {
    await send(
      '__send_request_files',
      {
        operation: 'chunk',
        transferId,
        fileIndex,
        chunkIndex,
        base64: chunk.toString('base64'),
      },
      TRANSFER_ACTION_TIMEOUT_MS,
    );
    chunkIndex += 1;
  };

  if (file.filePath) {
    for await (const chunk of createReadStream(file.filePath, {
      highWaterMark: FILE_CHUNK_BYTES,
    })) {
      await sendChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return;
  }

  const content = file.content!;
  for (let offset = 0; offset < content.byteLength; offset += FILE_CHUNK_BYTES) {
    await sendChunk(content.subarray(offset, offset + FILE_CHUNK_BYTES));
  }
}

interface PreparedFileTransfer {
  transferId: string;
  request: Omit<SendRequestParams, 'files' | 'bodyFile'>;
  binaryBody: boolean;
}

function assertPublicFileRequest(data: unknown): void {
  if (data && typeof data === 'object' && ('transferId' in data || 'binaryBody' in data)) {
    throw new Error('File transfer references are internal to native-host');
  }
}

async function prepareFileTransfer(
  data: SendRequestParams,
  send: SendExtensionTransferAction,
): Promise<PreparedFileTransfer> {
  assertPublicFileRequest(data);
  const bodyFile = getSendRequestBodyFile(data);
  const files = await resolveSendRequestFiles(bodyFile ? [bodyFile] : (data.files ?? []));
  if (files.length === 0) {
    throw new Error('files must contain at least one file');
  }

  const transferId = randomUUID();
  await send(
    '__send_request_files',
    {
      operation: 'start',
      transferId,
      files: files.map(file => file.descriptor),
      url: data.url,
      withCookies: data.withCookies,
    },
    TRANSFER_ACTION_TIMEOUT_MS,
  );

  try {
    for (let index = 0; index < files.length; index += 1) {
      await sendFileChunks(transferId, index, files[index]!, send);
    }
  } catch (error) {
    await abortFileTransfer(transferId, send);
    throw error;
  }

  const { files: _files, bodyFile: _bodyFile, ...request } = data;
  return { transferId, request, binaryBody: Boolean(bodyFile) };
}

async function abortFileTransfer(
  transferId: string,
  send: SendExtensionTransferAction,
): Promise<void> {
  await send(
    '__send_request_files',
    { operation: 'abort', transferId },
    TRANSFER_ACTION_TIMEOUT_MS,
  ).catch(() => {});
}

export function hasSendRequestFiles(data: unknown): boolean {
  return (
    !!data &&
    typeof data === 'object' &&
    ((data as SendRequestParams).bodyFile !== undefined ||
      (Array.isArray((data as SendRequestParams).files) &&
        (data as SendRequestParams).files!.length > 0))
  );
}

export function hasRunActionsSendRequestFiles(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const actions = (data as RunActionsParams).actions;
  return (
    Array.isArray(actions) &&
    actions.some(step => step?.action === 'send_request' && hasSendRequestFiles(step.data))
  );
}

export async function sendRequestWithTransferredFiles(
  data: SendRequestParams,
  send: SendExtensionTransferAction,
): Promise<any> {
  const prepared = await prepareFileTransfer(data, send);
  try {
    const requestTimeout = Number(data.timeout ?? 30000);
    return await send(
      'send_request',
      {
        ...prepared.request,
        transferId: prepared.transferId,
        ...(prepared.binaryBody ? { binaryBody: true } : {}),
      },
      (Number.isFinite(requestTimeout) && requestTimeout > 0 ? requestTimeout : 30000) + 5000,
    );
  } catch (error) {
    await abortFileTransfer(prepared.transferId, send);
    throw error;
  }
}

export async function sendRunActionsWithTransferredFiles(
  data: RunActionsParams,
  send: SendExtensionTransferAction,
  resolveTimeoutMs: (data: RunActionsParams) => number,
): Promise<any> {
  if (!Array.isArray(data.actions)) {
    throw new Error('actions must be an array');
  }

  const preparedTransferIds: string[] = [];
  try {
    const actions = [];
    for (let index = 0; index < data.actions.length; index += 1) {
      const step = data.actions[index]!;
      const action = String(step.action ?? '');
      if (action.startsWith('__')) {
        throw new Error(`Step ${index}: internal action "${action}" is not available to clients`);
      }
      if (action === 'send_request') assertPublicFileRequest(step.data);
      if (action === 'page_upload' && Object.hasOwn(step.data ?? {}, 'stagedUpload'))
        throw new Error('Page upload references are internal to native-host');
      if (action !== 'send_request' || !hasSendRequestFiles(step.data)) {
        actions.push(step);
        continue;
      }

      const prepared = await prepareFileTransfer(step.data as unknown as SendRequestParams, send);
      preparedTransferIds.push(prepared.transferId);
      actions.push({
        action: 'send_request',
        data: {
          ...prepared.request,
          transferId: prepared.transferId,
          ...(prepared.binaryBody ? { binaryBody: true } : {}),
        },
      });
    }

    const transformed = { ...data, actions } as RunActionsParams;
    return await send('run_actions', transformed, resolveTimeoutMs(transformed));
  } finally {
    await Promise.all(preparedTransferIds.map(transferId => abortFileTransfer(transferId, send)));
  }
}
