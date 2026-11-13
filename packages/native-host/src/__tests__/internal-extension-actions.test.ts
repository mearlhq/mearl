import { describe, expect, it } from 'vitest';
import { TOOLBOX_SERVICE_ACTIONS } from '@mearl/browser-core';
import {
  createExtensionRequestMessage,
  isPrivateExtensionAction,
} from '../internal-extension-actions.js';

describe('internal extension action boundary', () => {
  it('recognizes only privileged native-host helper actions', () => {
    expect(isPrivateExtensionAction('__export_cookies')).toBe(true);
    expect(isPrivateExtensionAction('__send_request_files')).toBe(true);
    expect(isPrivateExtensionAction('__preset_browser')).toBe(true);
    expect(isPrivateExtensionAction('__browser_enhancement')).toBe(true);
    expect(isPrivateExtensionAction('preset_browser_transfer')).toBe(true);
    expect(isPrivateExtensionAction('preset_installation')).toBe(true);
    expect(isPrivateExtensionAction('__preset_installation')).toBe(true);
    expect(isPrivateExtensionAction('send_request')).toBe(false);
    expect(isPrivateExtensionAction('browser_sessions')).toBe(true);
    expect(isPrivateExtensionAction('browser_instances')).toBe(true);
    expect(isPrivateExtensionAction('browser_providers')).toBe(true);
    expect(isPrivateExtensionAction('__prepare_send_request')).toBe(false);
    expect(isPrivateExtensionAction('browser_manage')).toBe(false);
    expect(isPrivateExtensionAction('__unknown')).toBe(false);
  });

  it('keeps every toolbox service action private, including diagnostics', () => {
    for (const action of Object.keys(TOOLBOX_SERVICE_ACTIONS)) {
      expect(isPrivateExtensionAction(action), action).toBe(true);
    }
    expect(isPrivateExtensionAction('toolbox_unknown')).toBe(false);
    expect(isPrivateExtensionAction(null)).toBe(false);
  });

  it.each(['browser_list', 'browser_manage', 'browser_close', 'browser_manage release'])(
    'keeps the public browser action %s available to clients',
    action => {
      expect(isPrivateExtensionAction(action)).toBe(false);
    },
  );

  it('adds the trust marker only for native-host initiated requests', () => {
    expect(createExtensionRequestMessage('1', 'tab_list', {})).toEqual({
      id: '1',
      action: 'tab_list',
      data: {},
      controlSource: 'local',
    });
    expect(createExtensionRequestMessage('2', '__export_cookies', { domains: [] }, true)).toEqual({
      id: '2',
      action: '__export_cookies',
      data: { domains: [] },
      controlSource: 'local',
      trustedInternal: true,
    });
  });

  it('uses the compatible extension wire value for remote control', () => {
    expect(createExtensionRequestMessage('3', 'tab_list', {}, false, 'remote')).toEqual({
      id: '3',
      action: 'tab_list',
      data: {},
      controlSource: 'cloud',
    });
  });
});
