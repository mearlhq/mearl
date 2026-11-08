import { describe, expect, it } from 'vitest';
import { COMMAND_MAP } from '../commands.js';
import { TAB_ID_REQUIRED_ACTIONS } from '@mearl/browser-core';

describe('command parameter contracts', () => {
  it('does not expose retired internal business actions', () => {
    expect(COMMAND_MAP.has('get_api_schema')).toBe(false);
    expect(COMMAND_MAP.has('get_user_info')).toBe(false);
  });

  it.each(TAB_ID_REQUIRED_ACTIONS.filter(action => action !== 'capture_checkpoint'))(
    '%s exposes tabId as required',
    action => {
      expect(COMMAND_MAP.get(action)?.params?.find(param => param.name === 'tabId')).toMatchObject({
        required: true,
      });
    },
  );

  it('keeps required tabId command params aligned with the shared action contract', () => {
    const requiredByCommands = Array.from(COMMAND_MAP.values())
      .filter(command =>
        command.params?.some(param => param.name === 'tabId' && param.required === true),
      )
      .map(command => command.name)
      .sort();

    expect(requiredByCommands).toEqual(
      TAB_ID_REQUIRED_ACTIONS.filter(action => action !== 'capture_checkpoint').sort(),
    );
  });

  it('warns that browser_release clears persistent session effects', () => {
    const description = COMMAND_MAP.get('browser_release')?.description;

    expect(description).toContain('设备/时区模拟');
    expect(description).toContain('不用于普通任务收尾');
    expect(description).toContain('mearl <providerId>');
  });

  it('documents structured Provider options without changing built-in launch parameters', () => {
    const params = COMMAND_MAP.get('browser_launch')?.params ?? [];
    expect(params.find(param => param.name === 'providerOptions')?.description).toContain('结构化');
    expect(params.some(param => param.name === 'mode')).toBe(false);
    expect(params.some(param => param.name === 'sessionId')).toBe(false);
  });

  it('documents that device emulation depends on active debugger control', () => {
    const command = COMMAND_MAP.get('set_device_emulation');
    expect(command?.description).toContain('保持调试控制');
    expect(command?.params?.find(param => param.name === 'splitScreen')?.description).toContain(
      '横屏',
    );
  });

  it('exposes Protocol environment switching through App simulation', () => {
    const command = COMMAND_MAP.get('set_app_profile');

    expect(command?.params?.find(param => param.name === 'networkControl')).toMatchObject({
      type: 'object | null',
    });
  });
});
