import type { PluginInvocation, PluginInvokeOptions } from '@mearl/client';

export type PluginInvoker = (
  name: string,
  invocation: PluginInvocation,
  options?: PluginInvokeOptions,
) => Promise<unknown>;

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function requiredString(value: unknown, name: string): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new Error(`${name} must be a non-empty string`);
  return result;
}

export async function invokePluginTool(value: unknown, invoke: PluginInvoker): Promise<unknown> {
  const input = asRecord(value);
  if (!input) throw new Error('plugin arguments must be an object');
  const plugin = requiredString(input.plugin, 'plugin');
  const command = requiredString(input.command, 'command');
  const commandInput = input.input === undefined ? {} : asRecord(input.input);
  if (!commandInput) throw new Error('input must be an object');

  const options: PluginInvokeOptions = { source: 'mcp' };
  if (input.browser !== undefined) {
    options.browser = requiredString(input.browser, 'browser');
  }
  if (input.timeoutSec !== undefined) {
    if (
      typeof input.timeoutSec !== 'number' ||
      !Number.isFinite(input.timeoutSec) ||
      input.timeoutSec <= 0
    ) {
      throw new Error('timeoutSec must be a positive number');
    }
    options.timeoutSec = input.timeoutSec;
  }

  return invoke(plugin, { command, input: commandInput }, options);
}
