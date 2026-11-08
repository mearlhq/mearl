import { describe, expect, it, vi } from 'vitest';
import { DomainPermissionError } from '@mearl/browser-core';
import { createToolboxExtensionInvoker, extensionResponseError } from '../toolbox-permissions.js';
import { sendRequestWithTransferredFiles } from '../extension-file-transfer.js';

function blocked(action = 'send_request', domain = 'upload.example') {
  return extensionResponseError({
    error: 'Missing domain permission',
    errorDetails: { code: 'DOMAIN_PERMISSION_REQUIRED', action, domain, requestDispatched: false },
  });
}

describe('toolbox domain permissions', () => {
  it('restores structured permission failures without interpreting error text', () => {
    expect(blocked()).toBeInstanceOf(DomainPermissionError);
    expect(blocked()).toMatchObject({
      code: 'DOMAIN_PERMISSION_REQUIRED',
      action: 'send_request',
      domain: 'upload.example',
      requestDispatched: false,
    });
    const plain = extensionResponseError({
      error: new DomainPermissionError('send_request', 'upload.example').message,
    });
    expect(plain).not.toBeInstanceOf(DomainPermissionError);
    expect(
      extensionResponseError({
        error: 'Already dispatched',
        errorDetails: {
          code: 'DOMAIN_PERMISSION_REQUIRED',
          action: 'send_request',
          domain: 'upload.example',
          requestDispatched: true,
        },
      }),
    ).not.toBeInstanceOf(DomainPermissionError);
  });

  it('authorizes a file transfer before accepting chunks and submits the upload once', async () => {
    const send = vi
      .fn(async (action: string, _data: unknown) => {
        if (action === 'request_permission') return { granted: true };
        if (action === 'send_request') return { status: 201 };
        return {};
      })
      .mockRejectedValueOnce(blocked('__send_request_files'));
    const invoke = createToolboxExtensionInvoker(send);
    await expect(
      sendRequestWithTransferredFiles(
        {
          url: 'https://upload.example/shrink',
          method: 'POST',
          withCookies: false,
          bodyFile: { base64: Buffer.from('image').toString('base64'), contentType: 'image/png' },
        },
        (action, data, timeout) => invoke(action, data, timeout, true),
      ),
    ).resolves.toEqual({ status: 201 });
    expect(send.mock.calls.map(([action]) => action)).toEqual([
      '__send_request_files',
      'request_permission',
      '__send_request_files',
      '__send_request_files',
      'send_request',
    ]);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ operation: 'start' });
    expect(send.mock.calls[3]?.[1]).toMatchObject({ operation: 'chunk' });
    expect(send.mock.calls[2]).toEqual(send.mock.calls[0]);
    expect(send.mock.calls[1]).toEqual([
      'request_permission',
      { domain: 'upload.example' },
      100_000,
    ]);
  });

  it.each([false, undefined])(
    'keeps uploads undispatched when permission is not granted (%s)',
    async granted => {
      const send = vi.fn(async (action: string) => {
        if (action === 'request_permission') return { granted };
        throw blocked();
      });
      const invoke = createToolboxExtensionInvoker(send);
      await expect(invoke('send_request', {}, 5000)).rejects.toMatchObject({
        code: 'DOMAIN_PERMISSION_REQUIRED',
        requestDispatched: false,
      });
      await expect(invoke('send_request', {}, 5000)).rejects.toBeInstanceOf(DomainPermissionError);
      expect(
        send.mock.calls.filter(([action]) => action === 'request_permission'),
      ).toHaveLength(1);
    },
  );

  it('reuses a failed authorization decision until a new user operation', async () => {
    const send = vi.fn(async (action: string) => {
      if (action === 'request_permission') throw new Error('Permission request timeout');
      throw blocked();
    });
    const invoke = createToolboxExtensionInvoker(send);
    for (let index = 0; index < 2; index += 1) {
      await expect(invoke('send_request', {}, 5000)).rejects.toMatchObject({
        code: 'DOMAIN_PERMISSION_REQUIRED',
        requestDispatched: false,
        message: 'Permission request timeout',
      });
    }
    expect(
      send.mock.calls.filter(([action]) => action === 'request_permission'),
    ).toHaveLength(1);
    await expect(
      createToolboxExtensionInvoker(send)('send_request', {}, 5000),
    ).rejects.toBeInstanceOf(DomainPermissionError);
    expect(
      send.mock.calls.filter(([action]) => action === 'request_permission'),
    ).toHaveLength(2);
  });

  it('shares one authorization dialog between concurrent operations', async () => {
    let grant!: (value: { granted: boolean }) => void;
    const decision = new Promise<{ granted: boolean }>(resolve => {
      grant = resolve;
    });
    let authorized = false;
    const send = vi.fn(async (action: string) => {
      if (action === 'request_permission') return decision;
      if (!authorized) throw blocked();
      return { status: 201 };
    });
    const first = createToolboxExtensionInvoker(send)('send_request', { body: 'first' }, 5000);
    const second = createToolboxExtensionInvoker(send)('send_request', { body: 'second' }, 5000);
    await vi.waitFor(() =>
      expect(
        send.mock.calls.filter(([action]) => action === 'request_permission'),
      ).toHaveLength(1),
    );
    authorized = true;
    grant({ granted: true });
    await expect(Promise.all([first, second])).resolves.toEqual([{ status: 201 }, { status: 201 }]);
  });

  it('requests page permission before attachment resolution and retries the preflight once', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(blocked('page_runtime', 'medium.com'))
      .mockResolvedValueOnce({ granted: true })
      .mockResolvedValueOnce({ documentId: 'document' });
    const payload = { operation: 'resolve', tabId: 7, expectedDocumentId: 'document' };
    await expect(
      createToolboxExtensionInvoker(send)('page_runtime', payload, 15000),
    ).resolves.toEqual({ documentId: 'document' });
    expect(send.mock.calls).toEqual([
      ['page_runtime', payload, 15000, undefined],
      ['request_permission', { domain: 'medium.com' }, 100000],
      ['page_runtime', payload, 15000, undefined],
    ]);
  });

  it.each(['get', 'send', 'attach', 'message_commit', 'result_chunk'])(
    'does not prompt or replay instance traffic (%s)',
    async operation => {
      const error = blocked('page_runtime', 'medium.com');
      const send = vi.fn().mockRejectedValue(error);
      await expect(
        createToolboxExtensionInvoker(send)('page_runtime', { operation, tabId: 7 }, 15000),
      ).rejects.toBe(error);
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it('does not retry network failures or raw permission-like messages', async () => {
    for (const error of [
      new Error('Upload timeout'),
      new Error('send_request: Access to "upload.example" is not authorized.'),
    ]) {
      const send = vi.fn().mockRejectedValue(error);
      await expect(createToolboxExtensionInvoker(send)('send_request', {}, 5000)).rejects.toBe(
        error,
      );
      expect(send).toHaveBeenCalledOnce();
    }
  });

  it('retries only once after granting permission and preserves an uncertain upload failure', async () => {
    const uncertain = new Error('Upload timeout');
    const send = vi
      .fn()
      .mockRejectedValueOnce(blocked())
      .mockResolvedValueOnce({ granted: true })
      .mockRejectedValueOnce(uncertain);
    await expect(createToolboxExtensionInvoker(send)('send_request', {}, 5000)).rejects.toBe(
      uncertain,
    );
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not repeatedly prompt when permission remains missing after approval', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(blocked())
      .mockResolvedValueOnce({ granted: true })
      .mockRejectedValueOnce(blocked());
    await expect(
      createToolboxExtensionInvoker(send)('send_request', {}, 5000),
    ).rejects.toBeInstanceOf(DomainPermissionError);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not replay a compound action or an error associated with a different action', async () => {
    for (const error of [blocked('run_actions'), blocked('page_click')]) {
      const send = vi.fn().mockRejectedValue(error);
      await expect(createToolboxExtensionInvoker(send)('run_actions', {}, 5000)).rejects.toBe(
        error,
      );
      expect(send).toHaveBeenCalledOnce();
    }
  });
});
