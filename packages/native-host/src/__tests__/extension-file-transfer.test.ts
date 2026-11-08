import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEND_REQUEST_MAX_FILES, SEND_REQUEST_MAX_TOTAL_FILE_BYTES } from '@mearl/browser-core';
import {
  hasRunActionsSendRequestFiles,
  hasSendRequestFiles,
  sendRequestWithTransferredFiles,
  sendRunActionsWithTransferredFiles,
} from '../extension-file-transfer.js';

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe('extension file transfer', () => {
  it.each([{ transferId: 'client-reference' }, { binaryBody: true }])(
    'rejects client-supplied internal references before preparing files: %j',
    async fields => {
      const send = vi.fn();
      await expect(
        sendRequestWithTransferredFiles(
          {
            url: 'https://example.test/upload',
            method: 'POST',
            bodyFile: { base64: 'YWJj' },
            ...fields,
          },
          send,
        ),
      ).rejects.toThrow('File transfer references are internal to native-host');
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('rejects injected references in mixed batches and cleans up prepared files', async () => {
    const messages: Array<{ action: string; data: any }> = [];
    const send = vi.fn(async (action: string, data: any) => {
      messages.push({ action, data });
      return {};
    });
    await expect(
      sendRunActionsWithTransferredFiles(
        {
          actions: [
            {
              action: 'send_request',
              data: {
                url: 'https://example.test/upload',
                method: 'POST',
                bodyFile: { base64: 'YWJj' },
              },
            },
            {
              action: 'send_request',
              data: {
                url: 'https://other.test/upload',
                transferId: 'client-reference',
              } as any,
            },
          ],
        },
        send,
        () => 30000,
      ),
    ).rejects.toThrow('File transfer references are internal to native-host');
    expect(messages.map(({ action, data }) => [action, data.operation])).toEqual([
      ['__send_request_files', 'start'],
      ['__send_request_files', 'chunk'],
      ['__send_request_files', 'abort'],
    ]);
    expect(messages[2]!.data.transferId).toBe(messages[0]!.data.transferId);
  });

  it('chunks a raw body and sends only a binary marker with the final request', async () => {
    const content = Buffer.alloc(900_000, 255);
    const messages: Array<{ action: string; data: any }> = [];
    await sendRequestWithTransferredFiles(
      {
        url: 'https://example.test/upload',
        method: 'POST',
        bodyFile: { base64: content.toString('base64'), contentType: 'application/octet-stream' },
      },
      async (action, data) => {
        expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(1024 * 1024);
        messages.push({ action, data });
        return { status: 201 };
      },
    );
    const chunks = messages.filter(
      message => message.action === '__send_request_files' && message.data.operation === 'chunk',
    );
    expect(chunks).toHaveLength(4);
    const received = Buffer.concat(
      chunks.map(message => Buffer.from(message.data.base64, 'base64')),
    );
    expect(received.equals(content)).toBe(true);
    expect(messages.at(-1)?.data).toMatchObject({ binaryBody: true, method: 'POST' });
    expect(messages.at(-1)?.data.bodyFile).toBeUndefined();
  });
  it('streams local files to the extension without paths or cookies in the protocol', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-extension-transfer-'));
    tempPaths.push(tempDir);
    const filePath = path.join(tempDir, 'logo.png');
    const content = Buffer.alloc(600_000);
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
    fs.writeFileSync(filePath, content);

    const messages: Array<{ action: string; data: Record<string, unknown> }> = [];
    const result = await sendRequestWithTransferredFiles(
      {
        url: 'https://content.example/upload',
        method: 'POST',
        formData: { folder: 'logo' },
        files: [{ fieldName: 'file', filePath }],
        withCookies: true,
      },
      async (action, data) => {
        messages.push({ action, data });
        if (action === 'send_request') return { status: 200 };
        return { accepted: true };
      },
    );

    expect(result).toEqual({ status: 200 });
    expect(messages.map(message => [message.action, message.data.operation])).toEqual([
      ['__send_request_files', 'start'],
      ['__send_request_files', 'chunk'],
      ['__send_request_files', 'chunk'],
      ['__send_request_files', 'chunk'],
      ['send_request', undefined],
    ]);

    const start = messages[0]!.data as any;
    const chunks = messages.slice(1, -1).map(message => message.data as any);
    expect(start.files).toEqual([
      {
        fieldName: 'file',
        filename: 'logo.png',
        contentType: 'image/png',
        byteLength: content.byteLength,
      },
    ]);
    const received = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.base64, 'base64')));
    expect(received.equals(content)).toBe(true);

    const serializedMessages = JSON.stringify(messages);
    expect(serializedMessages).not.toContain(filePath);
    expect(serializedMessages).not.toContain('"Cookie"');
    expect(serializedMessages).not.toContain('"cookies"');

    const commit = messages.at(-1)!.data as any;
    expect(commit.url).toBe('https://content.example/upload');
    expect(commit.withCookies).toBe(true);
    expect(commit.files).toBeUndefined();
  });

  it('aborts the extension transfer when a chunk is rejected', async () => {
    const actions: Array<[string, unknown]> = [];
    const send = vi.fn(async (action: string, data: Record<string, unknown>) => {
      actions.push([action, data.operation]);
      if (action === '__send_request_files' && data.operation === 'chunk')
        throw new Error('chunk rejected');
      return { accepted: true };
    });

    await expect(
      sendRequestWithTransferredFiles(
        {
          url: 'https://content.example/upload',
          method: 'POST',
          files: [
            {
              fieldName: 'file',
              filename: 'logo.png',
              base64: Buffer.from('logo').toString('base64'),
            },
          ],
        },
        send,
      ),
    ).rejects.toThrow('chunk rejected');

    expect(actions).toEqual([
      ['__send_request_files', 'start'],
      ['__send_request_files', 'chunk'],
      ['__send_request_files', 'abort'],
    ]);
  });

  it('transfers files used by send_request steps inside run_actions', async () => {
    const messages: Array<{ action: string; data: Record<string, unknown>; timeoutMs: number }> =
      [];
    const send = vi.fn(async (action: string, data: Record<string, unknown>, timeoutMs: number) => {
      messages.push({ action, data, timeoutMs });
      if (action === 'run_actions') return { completedSteps: 1 };
      return { accepted: true };
    });

    const result = await sendRunActionsWithTransferredFiles(
      {
        tabId: 1,
        actions: [
          {
            action: 'send_request',
            data: {
              url: 'https://content.example/upload',
              method: 'POST',
              files: [
                {
                  fieldName: 'file',
                  filename: 'logo.txt',
                  base64: Buffer.from('logo').toString('base64'),
                },
              ],
            },
          },
        ],
      },
      send,
      () => 45000,
    );

    expect(result).toEqual({ completedSteps: 1 });
    expect(messages.map(message => [message.action, message.data.operation])).toEqual([
      ['__send_request_files', 'start'],
      ['__send_request_files', 'chunk'],
      ['run_actions', undefined],
      ['__send_request_files', 'abort'],
    ]);
    const runActions = messages[2]!.data as any;
    expect(runActions.actions[0].action).toBe('send_request');
    expect(runActions.actions[0].data.files).toBeUndefined();
    expect(runActions.actions[0].data.transferId).toBeTypeOf('string');
    expect(messages[2]!.timeoutMs).toBe(45000);
  });

  it('only intercepts non-empty file lists', () => {
    expect(hasSendRequestFiles({ url: 'https://example.com', formData: { a: 1 } })).toBe(false);
    expect(hasSendRequestFiles({ url: 'https://example.com', files: [] })).toBe(false);
    expect(
      hasSendRequestFiles({
        url: 'https://example.com',
        files: [{ fieldName: 'file', filePath: '/tmp/file.png' }],
      }),
    ).toBe(true);
    expect(
      hasRunActionsSendRequestFiles({
        actions: [
          {
            action: 'send_request',
            data: { files: [{ fieldName: 'file', filePath: '/tmp/file.png' }] },
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects excessive file counts before starting a transfer', async () => {
    const files = Array.from({ length: SEND_REQUEST_MAX_FILES + 1 }, (_, index) => ({
      fieldName: `file${index}`,
      filename: `${index}.txt`,
      base64: '',
    }));

    await expect(
      sendRequestWithTransferredFiles(
        {
          url: 'https://content.example/upload',
          method: 'POST',
          files,
        },
        vi.fn(),
      ),
    ).rejects.toThrow(`files exceeds maximum of ${SEND_REQUEST_MAX_FILES}`);
  });

  it('rejects oversized local files before streaming bytes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-extension-transfer-limit-'));
    tempPaths.push(tempDir);
    const filePath = path.join(tempDir, 'large.bin');
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, SEND_REQUEST_MAX_TOTAL_FILE_BYTES + 1);
    const send = vi.fn();

    await expect(
      sendRequestWithTransferredFiles(
        {
          url: 'https://content.example/upload',
          method: 'POST',
          files: [{ fieldName: 'file', filePath }],
        },
        send,
      ),
    ).rejects.toThrow('files total size exceeds');
    expect(send).not.toHaveBeenCalled();
  });
});
