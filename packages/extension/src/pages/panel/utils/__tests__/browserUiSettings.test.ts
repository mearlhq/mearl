import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { callBrowserUiOperationResult, ensureBrowserUiSettings, refreshBrowserUiSettings, getBrowserUiSettings, useBrowserAppProfiles } from '../browserUiSettings';
import { act, renderHook } from '@testing-library/react';
let receive: (value: any) => void;
let disconnect: () => void;
let port: any;
beforeEach(() => {
  vi.useFakeTimers();
  port = { disconnect: vi.fn(), postMessage: vi.fn(), onMessage: { addListener: vi.fn(fn => { receive = fn; }) }, onDisconnect: { addListener: vi.fn(fn => { disconnect = fn; }) } };
  chrome.runtime.connect = vi.fn(() => port) as any;
});
afterEach(() => vi.useRealTimers());
it('returns provider identity and releases its one-request port on success', async () => {
  const result = callBrowserUiOperationResult('skills.catalog', { operation: 'describe' });
  expect(port.postMessage).toHaveBeenCalledWith({ operation: 'invoke', name: 'skills.catalog', input: { operation: 'describe' }, provider: undefined });
  receive({ success: true, data: { available: true }, provider: { bundleId: 'fixture', revision: 'accepted' } });
  await expect(result).resolves.toEqual({ data: { available: true }, provider: { bundleId: 'fixture', revision: 'accepted' } });
  expect(port.disconnect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it.each(['abort', 'disconnect', 'timeout'])('rejects %s and ignores late results', async reason => {
  const controller = new AbortController();
  const result = callBrowserUiOperationResult('skills.catalog', {}, { signal: controller.signal });
  const rejected = expect(result).rejects.toThrow();
  if (reason === 'abort') controller.abort(); else if (reason === 'disconnect') disconnect(); else await vi.advanceTimersByTimeAsync(135000);
  await rejected;
  receive({ success: true, data: 'late', provider: { bundleId: 'fixture', revision: 'late' } });
  expect(port.disconnect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('shares the initial settings request across concurrent consumers', async () => {
  chrome.runtime.sendMessage = vi.fn().mockResolvedValue({ success: true, data: {} });
  await Promise.all([ensureBrowserUiSettings(), ensureBrowserUiSettings()]);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
});

it('retains the last working settings when a refreshed control is invalid', async () => {
  chrome.runtime.sendMessage = vi.fn().mockResolvedValueOnce({ success: true, data: { links: { manual: 'https://example.test/old' } } }).mockResolvedValueOnce({ success: true, data: { links: { manual: 'https://example.test/new' } }, browserControl: { bundleId: 'example', revision: 'two', definition: {} } });
  await refreshBrowserUiSettings();
  const previous = getBrowserUiSettings();
  await expect(refreshBrowserUiSettings()).rejects.toThrow();
  expect(getBrowserUiSettings()).toBe(previous);
});

it('retains the last working snapshot when refreshed functional declarations are invalid', async () => {
  chrome.runtime.sendMessage = vi.fn()
    .mockResolvedValueOnce({ success: true, data: { links: { manual: 'https://example.test/old' } } })
    .mockResolvedValueOnce({ success: true, data: { links: { manual: 'https://example.test/new' } }, contributions: { schemaVersion: 1, operations: { account: { hook: 'identity', setting: 'agentEnabled' } } } });
  await refreshBrowserUiSettings();
  const previous = getBrowserUiSettings();
  await expect(refreshBrowserUiSettings()).rejects.toThrow('Invalid extension operation');
  expect(getBrowserUiSettings()).toBe(previous);
});

it('publishes installed App presentation with its settings and preserves the snapshot on invalid refresh', async () => {
  const app = { id: 'example/app', label: 'Example', definition: { labels: { en: 'Example', zh_CN: '示例' } } };
  chrome.runtime.sendMessage = vi.fn().mockResolvedValueOnce({ success: true, data: {}, appProfiles: [app, { id: 'offline/app', label: 'Offline', available: false }] }).mockResolvedValueOnce({ success: true, data: {}, appProfiles: [{ id: 'broken' }] }).mockResolvedValueOnce({ success: true, data: {}, appProfiles: [] });
  await refreshBrowserUiSettings();
  const hook = renderHook(() => useBrowserAppProfiles());
  expect(hook.result.current).toEqual([app]);
  await expect(refreshBrowserUiSettings()).rejects.toThrow();
  expect(hook.result.current).toEqual([app]);
  await act(async () => { await refreshBrowserUiSettings(); });
  expect(hook.result.current).toEqual([]);
});
