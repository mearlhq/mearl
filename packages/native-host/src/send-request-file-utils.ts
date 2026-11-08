import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import {
  assertSafeSendRequestMultipartValue,
  assertSendRequestBase64FileLimits,
  assertSendRequestFileCount,
  assertSendRequestFileLimits,
  decodeSendRequestBase64Bytes,
  inferSendRequestContentType,
  type SendRequestFile,
} from '@mearl/browser-core';

interface SendRequestFileDescriptor {
  fieldName: string;
  filename: string;
  contentType: string;
  byteLength: number;
}

export interface ResolvedSendRequestFile {
  descriptor: SendRequestFileDescriptor;
  filePath?: string;
  content?: Buffer;
}

async function resolveSendRequestFile(
  file: SendRequestFile,
  index: number,
): Promise<ResolvedSendRequestFile> {
  if (!file || typeof file !== 'object') {
    throw new Error(`files[${index}] must be an object`);
  }

  const fieldName = assertSafeSendRequestMultipartValue(
    file.fieldName,
    `files[${index}].fieldName`,
  );
  const hasPath = typeof file.filePath === 'string' && file.filePath.length > 0;
  const hasBase64 = typeof file.base64 === 'string';
  if (hasPath === hasBase64) {
    throw new Error(`files[${index}] must provide exactly one of filePath or base64`);
  }

  let filename: string;
  let byteLength: number;
  let filePath: string | undefined;
  let content: Buffer | undefined;

  if (hasPath) {
    filePath = file.filePath!;
    if (!isAbsolute(filePath)) {
      throw new Error(`files[${index}].filePath must be an absolute path`);
    }
    let metadata;
    try {
      metadata = await stat(filePath);
    } catch (error) {
      throw new Error(
        `Unable to read files[${index}].filePath: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!metadata.isFile()) throw new Error(`files[${index}].filePath is not a file`);
    filename = file.filename || basename(filePath);
    byteLength = metadata.size;
  } else {
    filename = file.filename || '';
    if (!filename) throw new Error(`files[${index}].filename is required when base64 is used`);
    const bytes = decodeSendRequestBase64Bytes(file.base64, `files[${index}].base64`);
    content = Buffer.from(bytes);
    byteLength = content.byteLength;
  }

  const safeFilename = assertSafeSendRequestMultipartValue(filename, `files[${index}].filename`);
  const contentType =
    typeof file.contentType === 'string' && file.contentType.trim()
      ? assertSafeSendRequestMultipartValue(file.contentType.trim(), `files[${index}].contentType`)
      : inferSendRequestContentType(filename);

  return {
    descriptor: { fieldName, filename: safeFilename, contentType, byteLength },
    filePath,
    content,
  };
}

export async function resolveSendRequestFiles(
  files: SendRequestFile[],
): Promise<ResolvedSendRequestFile[]> {
  assertSendRequestFileCount(files.length);
  const resolved = await Promise.all(files.map(resolveSendRequestFile));
  assertSendRequestFileLimits(resolved.map(file => file.descriptor.byteLength));
  assertSendRequestBase64FileLimits(
    resolved.flatMap(file => (file.content ? [file.content.byteLength] : [])),
  );
  return resolved;
}
