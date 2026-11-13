import { describe, it, expect } from 'vitest';
import {
  getExtensionServiceTimeout,
  isExtensionUiServiceAction,
  isPrivateExtensionServiceAction,
  isHostToExtensionAction,
} from '../extensionServiceProtocol';

describe('extension RPC contracts', () => {
  it.each(['toString', 'constructor', '__proto__', 'page_eval', 'unknown_action'])(
    'keeps %s outside the UI service route',
    action => {
      expect(isExtensionUiServiceAction(action)).toBe(false);
      expect(isPrivateExtensionServiceAction(action)).toBe(false);
      expect(isHostToExtensionAction(action)).toBe(false);
    },
  );
  it('distinguishes shared browser services from privileged helpers and private management', () => {
    expect(isExtensionUiServiceAction('browser_manage')).toBe(true);
    expect(isPrivateExtensionServiceAction('browser_manage')).toBe(false);
    expect(isPrivateExtensionServiceAction('browser_instances')).toBe(true);
    expect(isPrivateExtensionServiceAction('agent_chat_run')).toBe(false);
    expect(isHostToExtensionAction('__send_request_files')).toBe(true);
    expect(isHostToExtensionAction('__preset_browser')).toBe(true);
    expect(isPrivateExtensionServiceAction('preset_browser_transfer')).toBe(true);
    expect(isPrivateExtensionServiceAction('preset_installation')).toBe(true);
    expect(isHostToExtensionAction('__preset_installation')).toBe(true);
    expect(isExtensionUiServiceAction('preset_installation')).toBe(false);
    expect(isExtensionUiServiceAction('preset_browser_transfer')).toBe(false);
    expect(isExtensionUiServiceAction('__send_request_files')).toBe(false);
    expect(isExtensionUiServiceAction('plugin_page_event')).toBe(false);
    expect(isPrivateExtensionServiceAction('plugin_page_event')).toBe(true);
  });
  it('preserves operation-specific long polling and mutation timeouts', () => {
    expect(getExtensionServiceTimeout('toolbox_task', { operation: 'events' })).toBe(40000);
    expect(getExtensionServiceTimeout('toolbox_task', { operation: 'get' })).toBe(15000);
    expect(getExtensionServiceTimeout('browser_instances', { operation: 'sync_cookies' })).toBe(
      120000,
    );
    expect(getExtensionServiceTimeout('browser_instances', { operation: 'detach' })).toBe(60000);
    expect(getExtensionServiceTimeout('browser_providers', { operation: 'launch_form' })).toBe(
      120000,
    );
    expect(getExtensionServiceTimeout('browser_providers', { operation: 'list' })).toBe(15000);
    expect(getExtensionServiceTimeout('agent_chat_pick_directory')).toBe(300000);
    expect(getExtensionServiceTimeout('agent_skills_install')).toBe(600000);
    expect(getExtensionServiceTimeout('agent_skills_update')).toBe(600000);
    expect(getExtensionServiceTimeout('agent_skills_installed')).toBe(130000);
  });
});
