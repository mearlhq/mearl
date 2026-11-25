import { expect, it } from 'vitest';
import type { BrowserDetails, BrowserStatus, BrowserTransport } from './browserActionProtocol.js';
import { isDiscoverableBrowser } from './providerTask.js';

type Route = {
  id: string;
  transport: BrowserTransport;
  status: BrowserStatus;
  details?: BrowserDetails;
};
const direct: Route = { id: 'direct', transport: 'extension', status: 'connected' };
const taskHost: Route = {
  id: 'provider',
  transport: 'provider',
  status: 'connected',
  details: { taskSessionScope: 'browser' },
};
const task: Route = {
  id: 'task',
  transport: 'provider',
  status: 'connected',
  details: { taskSessionScope: 'session' },
};

it('keeps the ordinary extension route and the running browser entry while hiding task handles', () => {
  expect([direct, taskHost, task].filter(isDiscoverableBrowser)).toEqual([direct, taskHost]);
});
