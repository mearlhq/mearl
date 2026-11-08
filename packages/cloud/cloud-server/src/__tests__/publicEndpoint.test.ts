import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudServer } from '../index.js';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
import { formatConnectorCommand, resolveCloudPublicEndpoint } from '../publicEndpoint.js';

describe('explicit cloud ingress configuration', () => {
  it('leaves endpoint discovery to the ordinary host when no ingress is configured', () => {
    expect(resolveCloudPublicEndpoint(8080, {})).toBeNull();
  });
  it('replaces every port placeholder and supplies HTTPS by default', () => {
    expect(resolveCloudPublicEndpoint(8080, { MEARL_CLOUD_PUBLIC_URL: 'workspace-{port}.example.com/{port}' })).toBe('https://workspace-8080.example.com/8080');
  });
  it('accepts a fixed deployment URL or an explicit scheme', () => {
    expect(resolveCloudPublicEndpoint(8080, { MEARL_CLOUD_PUBLIC_URL: 'wss://example.com/ws' })).toBe('wss://example.com/ws');
    expect(resolveCloudPublicEndpoint(8080, { MEARL_CLOUD_PUBLIC_URL: 'http://localhost:{port}' })).toBe('http://localhost:8080/');
  });
  it.each(['file://example.com', 'https://user:password@example.com', 'https://example.com/#part', 'https://'])('rejects invalid explicit configuration: %s', MEARL_CLOUD_PUBLIC_URL => {
    expect(() => resolveCloudPublicEndpoint(8080, { MEARL_CLOUD_PUBLIC_URL })).toThrow();
  });
});


it.each([
  ['https://gateway.example/proxy/{port}/ws?route=browser', 'wss://gateway.example/proxy/8080/ws?route=browser&token=fixture-token'],
  ['http://localhost:{port}', 'ws://localhost:8080/ws?token=fixture-token'],
])('publishes the configured external path and query: %s', async (source, expected) => {
  vi.stubEnv('MEARL_CLOUD_PUBLIC_URL', source);
  const server = new CloudServer({ token: 'fixture-token' });
  vi.spyOn(server as any, 'createListener').mockResolvedValue(undefined);
  vi.spyOn(server as any, 'writeConfigFile').mockImplementation(() => {});
  vi.spyOn(server as any, 'startHeartbeatCheck').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const info = await server.start();
  expect(info.publicUrl).toBe(expected);
  expect(info.connectorCommand).toContain(expected);
});

it('rejects invalid ingress before opening a listener', async () => {
  vi.stubEnv('MEARL_CLOUD_PUBLIC_URL', 'file://gateway.example');
  const server = new CloudServer();
  const listen = vi.spyOn(server as any, 'createListener').mockResolvedValue(undefined);
  await expect(server.start()).rejects.toThrow();
  expect(listen).not.toHaveBeenCalled();
});


it('quotes a shell-active external path as one literal POSIX argument', async () => {
  const { execFileSync } = await import('node:child_process');
  const url = "wss://gateway.example/proxy/$(printf unexpected)/it's/ws?token=fixture";
  const command = formatConnectorCommand(url);
  expect(command.startsWith("npx @mearl/cloud-connector start '")).toBe(true);
  if (process.platform !== 'win32') {
    expect(execFileSync('/bin/sh', ['-c', command.replace('npx @mearl/cloud-connector start', "printf '%s'")], { encoding: 'utf8' })).toBe(url);
  }
  expect(formatConnectorCommand('wss://gateway.example/ws?token=fixture')).toBe('npx @mearl/cloud-connector start "wss://gateway.example/ws?token=fixture"');
});
