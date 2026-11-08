import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { executeNodeSendRequest } from '../send-request.js';

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Server did not expose a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

describe('executeNodeSendRequest', () => {
  it('posts exact raw file bytes and a binary content type', async () => {
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    let received = Buffer.alloc(0);
    let contentType: string | undefined;
    const server = http.createServer((request, response) => {
      contentType = request.headers['content-type'];
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received = Buffer.concat(chunks);
        response.end('{}');
      });
    });
    const port = await listen(server);
    try {
      await executeNodeSendRequest({
        url: `http://127.0.0.1:${port}`,
        method: 'POST',
        bodyFile: { base64: bytes.toString('base64'), contentType: 'application/custom' },
      });
      expect(received).toEqual(bytes);
      expect(contentType).toBe('application/custom');
    } finally {
      await close(server);
    }
  });
  it('uploads local binary files as multipart form data without base64 transport', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-send-request-'));
    tempPaths.push(tempDir);
    const filePath = path.join(tempDir, 'pixel.png');
    const fileContent = Buffer.from([0, 255, 13, 10, 65, 66, 67]);
    fs.writeFileSync(filePath, fileContent);

    let receivedHeaders: http.IncomingHttpHeaders = {};
    let receivedBody = Buffer.alloc(0);
    const server = http.createServer((request, response) => {
      receivedHeaders = request.headers;
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        receivedBody = Buffer.concat(chunks);
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Set-Cookie', 'upload-token=private');
        response.end(
          JSON.stringify({
            url: 'https://img.example/pixel.png',
            h5url: 'https://m.example/pixel.png',
          }),
        );
      });
    });
    const port = await listen(server);

    try {
      const result = await executeNodeSendRequest(
        {
          url: `http://127.0.0.1:${port}/upload`,
          method: 'POST',
          formData: { folder: '', isPrivate: false },
          files: [{ fieldName: 'file', filePath }],
        },
        [{ name: 'session', value: 'secret' }],
      );

      expect(result.status).toBe(200);
      expect(result.bodyType).toBe('json');
      expect(result.body).toEqual({
        url: 'https://img.example/pixel.png',
        h5url: 'https://m.example/pixel.png',
      });
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(receivedHeaders.cookie).toBe('session=secret');
      expect(receivedHeaders['content-type']).toMatch(/^multipart\/form-data; boundary=----mearl-/);
      expect(Number(receivedHeaders['content-length'])).toBe(receivedBody.byteLength);
      expect(receivedBody.includes(fileContent)).toBe(true);
      expect(receivedBody.toString('latin1')).toContain(
        'Content-Disposition: form-data; name="file"; filename="pixel.png"',
      );
      expect(receivedBody.toString('latin1')).toContain(
        'Content-Disposition: form-data; name="isPrivate"\r\n\r\nfalse',
      );
    } finally {
      await close(server);
    }
  });

  it('rejects relative file paths before sending a request', async () => {
    await expect(
      executeNodeSendRequest({
        url: 'https://example.com/upload',
        method: 'POST',
        files: [{ fieldName: 'file', filePath: 'relative.png' }],
      }),
    ).rejects.toThrow('filePath must be an absolute path');
  });

  it('rejects malformed Base64 instead of silently uploading truncated bytes', async () => {
    await expect(
      executeNodeSendRequest({
        url: 'https://example.com/upload',
        method: 'POST',
        files: [{ fieldName: 'file', filename: 'file.txt', base64: 'YQ=' }],
      }),
    ).rejects.toThrow('files[0].base64 must be valid base64');
  });

  it('returns binary responses as base64 in auto mode', async () => {
    const responseBytes = Buffer.from([0, 1, 2, 255]);
    const server = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'image/png');
      response.end(responseBytes);
    });
    const port = await listen(server);

    try {
      const result = await executeNodeSendRequest({
        url: `http://127.0.0.1:${port}/image`,
        responseType: 'auto',
      });
      expect(result.bodyType).toBe('base64');
      expect(result.body).toBe(responseBytes.toString('base64'));
    } finally {
      await close(server);
    }
  });
});
