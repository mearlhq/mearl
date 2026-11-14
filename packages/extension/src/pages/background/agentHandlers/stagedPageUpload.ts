import {
  inferSendRequestContentType,
  PageActionPreconditionError,
  PageActionDispatchUncertainError,
  type PageUploadChunk,
  type PageUploadChunkRequest,
  type PageUploadTransfer,
} from '@mearl/browser-core';
import { sendPageCommand } from '../pageDialogs';

export interface StagedUploadSource {
  readChunk(request: PageUploadChunkRequest): Promise<PageUploadChunk>;
  authorizeDocument(url: string): Promise<void>;
  signal?: AbortSignal;
}

// Serialized into a Chrome isolated world. Only the completed FileList is visible to the page.
function prepareUploadInPage(
  this: HTMLInputElement,
  files: Array<{ name: string; type: string }>,
  url: string,
  deadline: number,
) {
  const document = this.ownerDocument;
  if (this.localName !== 'input' || this.type !== 'file' || !this.isConnected)
    throw new Error('page_upload: selector must point to a connected <input type="file"> element.');
  if (document.URL !== url) throw new Error('Upload document changed');
  const parts: Uint8Array<ArrayBuffer>[][] = files.map(() => []);

  return (fileIndex?: number, base64?: string) => {
    if (fileIndex !== undefined) {
      parts[fileIndex]!.push(Uint8Array.from(atob(base64!), character => character.charCodeAt(0)));
      return;
    }
    if (
      Date.now() >= deadline ||
      this.ownerDocument !== document ||
      document.URL !== url ||
      !this.isConnected ||
      this.type !== 'file' ||
      (files.length > 1 && !this.multiple)
    )
      return false;
    const transfer = new DataTransfer();
    for (const [index, file] of files.entries())
      transfer.items.add(new File(parts[index]!, file.name, { type: file.type }));
    parts.length = 0;
    if (Date.now() >= deadline) return false;
    this.files = transfer.files;
    this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
}

export async function uploadStagedFiles(
  target: { tabId: number; sessionId?: string },
  inputId: string,
  upload: PageUploadTransfer,
  source: StagedUploadSource,
): Promise<void> {
  const checkActive = () => {
    source.signal?.throwIfAborted();
    if (!Number.isFinite(upload.deadline) || Date.now() >= upload.deadline)
      throw new PageActionPreconditionError('Page upload deadline exceeded');
  };
  const call = async (
    objectId: string,
    functionDeclaration: string,
    args: unknown[] = [],
    returnByValue = true,
    onDispatch?: () => void,
  ) => {
    checkActive();
    const { result, exceptionDetails } = await sendPageCommand(
      target,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration,
        arguments: args.map(value => ({ value })),
        returnByValue,
      },
      () => {
        checkActive();
        onDispatch?.();
      },
    );
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result;
  };

  const input = await call(
    inputId,
    `function () {
    return this.localName === 'input' && this.type === 'file' && this.isConnected
      ? { url: this.ownerDocument.URL, multiple: this.multiple } : null;
  }`,
  );
  if (!input.value)
    throw new PageActionPreconditionError(
      'page_upload: selector must point to a connected <input type="file"> element.',
    );
  if (upload.files.length > 1 && !input.value.multiple)
    throw new PageActionPreconditionError('The file input does not allow multiple files');
  const url: string = input.value.url;
  await source.authorizeDocument(url);
  const files = upload.files.map(({ filename }) => ({
    name: filename,
    type: inferSendRequestContentType(filename),
  }));
  const { objectId } = await call(
    inputId,
    prepareUploadInPage.toString(),
    [files, url, upload.deadline],
    false,
  );
  if (!objectId) throw new Error('Could not prepare the page upload');
  const invoke = 'function (...args) { return this(...args); }';

  try {
    for (const [fileIndex, file] of upload.files.entries()) {
      for (let offset = 0; offset < file.bytes;) {
        checkActive();
        const chunk = await source.readChunk({
          id: upload.id,
          tabId: target.tabId,
          fileIndex,
          offset,
        });
        if (
          chunk.totalBytes !== file.bytes ||
          !Number.isSafeInteger(chunk.bytes) ||
          chunk.bytes <= 0 ||
          offset + chunk.bytes > file.bytes
        )
          throw new Error(`Invalid upload chunk for ${file.filename}`);
        await call(objectId, invoke, [fileIndex, chunk.base64]);
        offset += chunk.bytes;
      }
    }
    await source.authorizeDocument(url);
    let dispatched = false;
    let applied: boolean;
    try {
      const result = await call(objectId, invoke, [], true, () => {
        dispatched = true;
      });
      applied = result.value === true;
    } catch (error) {
      if (!dispatched) throw error;
      throw new PageActionDispatchUncertainError(
        'Chrome could not confirm file selection. Check the page before retrying the upload.',
        { cause: error },
      );
    }
    if (!applied) {
      checkActive();
      throw new PageActionPreconditionError('Upload document or file input changed');
    }
  } finally {
    await sendPageCommand(target, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}
