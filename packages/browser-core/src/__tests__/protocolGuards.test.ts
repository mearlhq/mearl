import { describe, expect, it } from 'vitest';
import { isAgentChatStreamMethod } from '../agentChat.js';
import { isAgentServiceAction } from '../agentServiceProtocol.js';
import {
  actionRequiresTabId,
  isBrowserAction,
  isBrowserCapabilityAction,
  isBrowserCommandAction,
  isExtensionBrowserAction,
  validateRequiredActionTabId,
} from '../browserActionProtocol.js';

describe('protocol action guards', () => {
  it.each(['get_cookie', 'set_cookie'])('allows %s without a tab when URL is explicit', action => {
    expect(actionRequiresTabId(action)).toBe(false);
    expect(() =>
      validateRequiredActionTabId(action, { url: 'https://example.com/' }),
    ).not.toThrow();
    expect(() => validateRequiredActionTabId(action, { tabId: 7 })).not.toThrow();
    expect(() => validateRequiredActionTabId(action, {})).toThrow('specify url or tabId');
    for (const tabId of [null, '7', -1, 1.5]) {
      expect(() =>
        validateRequiredActionTabId(action, { tabId, url: 'https://example.com/' }),
      ).toThrow('requires a numeric tabId');
    }
  });

  it('requires an explicit tab for cookie-triggered reload', () => {
    expect(() =>
      validateRequiredActionTabId('set_cookie', { url: 'https://example.com/', reload: true }),
    ).toThrow('reload requires tabId');
  });

  it('recognizes declared actions', () => {
    expect(isAgentServiceAction('agent_chat_status')).toBe(true);
    expect(isAgentServiceAction('agent_chat_prepare')).toBe(true);
    expect(isBrowserAction('browser_select_browser')).toBe(true);
    expect(isBrowserCommandAction('browser_list')).toBe(true);
    expect(isBrowserCapabilityAction('page_click')).toBe(true);
    expect(isBrowserCapabilityAction('page_download')).toBe(true);
    expect(isExtensionBrowserAction('page_download')).toBe(false);
    expect(isBrowserCapabilityAction('browser_list')).toBe(false);
    expect(isExtensionBrowserAction('page_click')).toBe(true);
    expect(isAgentChatStreamMethod('item/agentMessage/delta')).toBe(true);
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'rejects inherited object property %s',
    property => {
      expect(isAgentServiceAction(property)).toBe(false);
      expect(isBrowserAction(property)).toBe(false);
      expect(isBrowserCommandAction(property)).toBe(false);
      expect(isBrowserCapabilityAction(property)).toBe(false);
      expect(isExtensionBrowserAction(property)).toBe(false);
      expect(isAgentChatStreamMethod(property)).toBe(false);
    },
  );

  it('requires explicit tab ids for tab-scoped actions', () => {
    for (const action of [
      'page_click',
      'set_timezone',
      'tab_checkpoint',
      'capture_checkpoint',
      'get_requests',
      'get_logs',
      'get_events',
      'set_mock',
      'get_mocks',
    ]) {
      expect(actionRequiresTabId(action)).toBe(true);
      expect(() => validateRequiredActionTabId(action, {})).toThrow(
        `${action} requires a numeric tabId`,
      );
      expect(() => validateRequiredActionTabId(action, { tabId: 7 })).not.toThrow();
    }
    expect(actionRequiresTabId('tab_open')).toBe(false);

    expect(() => validateRequiredActionTabId('page_click', { selector: '#submit' })).toThrow(
      'page_click requires a numeric tabId. Call tab_open or tab_list to obtain a tabId.',
    );
    expect(() => validateRequiredActionTabId('page_click', { tabId: 7 })).not.toThrow();
  });
});
