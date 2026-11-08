import { expect, it } from 'vitest';
import { parseCaptureState } from '../captureState';
const state = () => ({
  channels: { custom: { label: 'Custom device', supportsModify: true, connection: { status: 'connected', upstream: 'active', statusText: { connecting: 'Connecting', active: 'Online', idle: 'Offline' } }, overrides: [['api.name', { apiName: 'api.name' }]], onlineMocks: [] } },
  proxy: { activeProxy: { name: 'session' }, loading: false, synced: true, storageReady: true, sseUrl: 'https://example.test/stream' },
});
it('accepts declared channel metadata and optional online mock support', () => {
  expect(parseCaptureState(state()).channels.custom).toMatchObject({ label: 'Custom device', supportsModify: true, onlineMocks: [] });
});
it.each([
  (value: any) => { value.channels['not.a-channel'] = value.channels.custom; },
  (value: any) => { value.channels.custom.label = ''; },
  (value: any) => { value.channels.custom.supportsModify = 'yes'; },
  (value: any) => { value.channels.custom.overrides = [['invalid']]; },
  (value: any) => { value.channels.custom.onlineMocks = [false]; },
  (value: any) => { value.channels.custom.connection.status = 'unexpected'; },
  (value: any) => { value.channels.custom.connection.statusText = null; },
  (value: any) => { value.proxy.activeProxy = {}; },
  (value: any) => { value.proxy.synced = 1; },
])('rejects malformed controller snapshots %#', mutate => {
  const value = state(); mutate(value);
  expect(() => parseCaptureState(value)).toThrow();
});
