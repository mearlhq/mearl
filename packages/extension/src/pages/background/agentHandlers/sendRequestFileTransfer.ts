import {
  assertSafeSendRequestMultipartValue,
  assertSendRequestFileCount,
  assertSendRequestFileLimits,
  decodeSendRequestBase64Bytes,
} from '@mearl/browser-core';

const TRANSFER_TTL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_TRANSFERS = 4;

export interface TransferredRequestFile {
  fieldName: string;
  filename: string;
  contentType: string;
  file: File;
}

interface FileDescriptor {
  fieldName: string;
  filename: string;
  contentType: string;
  byteLength: number;
}

interface FileTransferState {
  descriptor: FileDescriptor;
  chunks: Array<Uint8Array<ArrayBuffer>>;
  nextChunkIndex: number;
  receivedBytes: number;
}

interface RequestTransferState {
  expiresAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  files: FileTransferState[];
}

const requestTransfers = new Map<string, RequestTransferState>();

function deleteTransfer(transferId: string): boolean {
  const transfer = requestTransfers.get(transferId);
  if (!transfer) return false;
  if (transfer.cleanupTimer !== undefined) clearTimeout(transfer.cleanupTimer);
  return requestTransfers.delete(transferId);
}

function refreshTransferExpiry(transferId: string, transfer: RequestTransferState): void {
  if (transfer.cleanupTimer !== undefined) clearTimeout(transfer.cleanupTimer);
  transfer.expiresAt = Date.now() + TRANSFER_TTL_MS;
  transfer.cleanupTimer = setTimeout(() => {
    if (requestTransfers.get(transferId) === transfer) requestTransfers.delete(transferId);
  }, TRANSFER_TTL_MS);
}

function cleanupExpiredTransfers(): void {
  const now = Date.now();
  for (const [transferId, transfer] of requestTransfers) {
    if (transfer.expiresAt <= now) deleteTransfer(transferId);
  }
}

function parseDescriptor(value: unknown, index: number): FileDescriptor {
  if (!value || typeof value !== 'object') {
    throw new Error(`files[${index}] must be an object`);
  }
  const file = value as Record<string, unknown>;
  const byteLength = Number(file.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`files[${index}].byteLength must be a non-negative safe integer`);
  }
  return {
    fieldName: assertSafeSendRequestMultipartValue(file.fieldName, `files[${index}].fieldName`),
    filename: assertSafeSendRequestMultipartValue(file.filename, `files[${index}].filename`),
    contentType: assertSafeSendRequestMultipartValue(
      file.contentType,
      `files[${index}].contentType`,
    ),
    byteLength,
  };
}

export function handleSendRequestFileStart(data: { transferId?: unknown; files?: unknown }): {
  accepted: true;
} {
  cleanupExpiredTransfers();
  const transferId = assertSafeSendRequestMultipartValue(data.transferId, 'transferId');
  if (!Array.isArray(data.files) || data.files.length === 0) {
    throw new Error('files must contain at least one file');
  }
  assertSendRequestFileCount(data.files.length);
  if (requestTransfers.has(transferId)) {
    throw new Error(`File transfer already exists: ${transferId}`);
  }
  if (requestTransfers.size >= MAX_ACTIVE_TRANSFERS) {
    throw new Error(`Active file transfers exceed maximum of ${MAX_ACTIVE_TRANSFERS}`);
  }

  const descriptors = data.files.map(parseDescriptor);
  assertSendRequestFileLimits(descriptors.map(file => file.byteLength));
  const transfer: RequestTransferState = {
    expiresAt: 0,
    files: descriptors.map(descriptor => ({
      descriptor,
      chunks: [],
      nextChunkIndex: 0,
      receivedBytes: 0,
    })),
  };
  requestTransfers.set(transferId, transfer);
  refreshTransferExpiry(transferId, transfer);
  return { accepted: true };
}

export function handleSendRequestFileChunk(data: {
  transferId?: unknown;
  fileIndex?: unknown;
  chunkIndex?: unknown;
  base64?: unknown;
}): { receivedBytes: number } {
  cleanupExpiredTransfers();
  const transferId = assertSafeSendRequestMultipartValue(data.transferId, 'transferId');
  const transfer = requestTransfers.get(transferId);
  if (!transfer) throw new Error(`Unknown or expired file transfer: ${transferId}`);

  const fileIndex = Number(data.fileIndex);
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex >= transfer.files.length) {
    throw new Error('fileIndex is out of range');
  }
  const file = transfer.files[fileIndex]!;
  const chunkIndex = Number(data.chunkIndex);
  if (chunkIndex !== file.nextChunkIndex) {
    throw new Error(
      `Unexpected chunk index for files[${fileIndex}]: expected ${file.nextChunkIndex}, got ${String(data.chunkIndex)}`,
    );
  }

  const bytes = decodeSendRequestBase64Bytes(
    data.base64,
    `files[${fileIndex}] chunk ${chunkIndex}`,
  );
  const receivedBytes = file.receivedBytes + bytes.byteLength;
  if (receivedBytes > file.descriptor.byteLength) {
    throw new Error(`Received too many bytes for files[${fileIndex}]`);
  }
  file.chunks.push(bytes);
  file.receivedBytes = receivedBytes;
  file.nextChunkIndex += 1;
  refreshTransferExpiry(transferId, transfer);
  return { receivedBytes };
}

export function handleSendRequestFileAbort(data: { transferId?: unknown }): { aborted: boolean } {
  const transferId = assertSafeSendRequestMultipartValue(data.transferId, 'transferId');
  return { aborted: deleteTransfer(transferId) };
}

export function consumeSendRequestFileTransfer(transferIdValue: unknown): TransferredRequestFile[] {
  cleanupExpiredTransfers();
  const transferId = assertSafeSendRequestMultipartValue(transferIdValue, 'transferId');
  const transfer = requestTransfers.get(transferId);
  if (!transfer) throw new Error(`Unknown or expired file transfer: ${transferId}`);
  deleteTransfer(transferId);

  return transfer.files.map((file, index) => {
    if (file.receivedBytes !== file.descriptor.byteLength) {
      throw new Error(
        `Incomplete files[${index}]: expected ${file.descriptor.byteLength} bytes, received ${file.receivedBytes}`,
      );
    }
    return {
      fieldName: file.descriptor.fieldName,
      filename: file.descriptor.filename,
      contentType: file.descriptor.contentType,
      file: new File(file.chunks, file.descriptor.filename, {
        type: file.descriptor.contentType,
      }),
    };
  });
}
