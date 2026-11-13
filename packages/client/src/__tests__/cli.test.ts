import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../capabilityHelp.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../capabilityHelp.js')>()),
  readHelpCapabilities: vi.fn(async () => undefined),
}));

const registeredProviders = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@mearl/provider/host', () => ({
  listInstalledProviders: () => registeredProviders,
}));

import { parseClientArgs, runMearlCli } from '../cli.js';
import { registerPlugin } from '../plugins/sdk/plugin.js';
import { UnifiedClient } from '../unified.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  registeredProviders.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  temporaryDirectories
    .splice(0)
    .forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('runMearlCli', () => {
  it('executes a default command without arguments and validates required inputs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-empty-default-plugin-cli-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
    const entry = join(directory, 'main.mjs');
    writeFileSync(
      entry,
      `export const defaultCommand = 'status'; export default app => app.command('status', () => ({ ready: true }));`,
    );
    registerPlugin('sample_status', entry);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMearlCli(['sample_status'])).toBe(0);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({ ready: true });
    expect(error).not.toHaveBeenCalled();
    const requiredEntry = join(directory, 'required.mjs');
    writeFileSync(
      requiredEntry,
      `export const defaultCommand = 'read'; export default app => app.command('read <url>', input => input);`,
    );
    registerPlugin('required_request', requiredEntry);
    expect(await runMearlCli(['required_request'])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('url'));
  });
  it('dispatches flat plugin payloads and named inputs through the declared default command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-default-plugin-cli-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
    const entry = join(directory, 'main.mjs');
    writeFileSync(
      entry,
      `export const name = 'sample_request'; export const defaultCommand = 'request'; export default app => app.command('request <url>', input => app.invoke('send_request', input));`,
    );
    registerPlugin('sample_request', entry);
    const invoke = vi
      .spyOn(UnifiedClient.prototype, 'invoke')
      .mockResolvedValue({ status: 200, body: 'ok' });
    vi.spyOn(UnifiedClient.prototype, 'disconnect').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const args of [
      ['--payload', '{"url":"https://example.test/","method":"POST"}'],
      ['--url=https://example.test/', '--method=POST'],
    ]) {
      expect(await runMearlCli(['sample_request', ...args, '--browser=target'])).toBe(0);
      expect(invoke).toHaveBeenLastCalledWith(
        'send_request',
        { url: 'https://example.test/', method: 'POST' },
        expect.objectContaining({ browser: 'target' }),
      );
    }
  });
  it('serves guide discovery before browser invocation or capability lookup', async () => {
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runMearlCli(['guide', '--list'], { clientVersion: '9.2.0' })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('CLI 9.2.0'));
    expect(invoke).not.toHaveBeenCalled();
  });
  it('keeps JSON results identical while compacting non-interactive output', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const value = { tabs: [{ tabId: 7, title: 'Example' }] };
    vi.spyOn(UnifiedClient.prototype, 'invoke').mockResolvedValue(value);
    vi.spyOn(UnifiedClient.prototype, 'disconnect').mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (const [tty, flags, compact] of [
        [false, [], true],
        [true, [], false],
        [true, ['--compact'], true],
      ] as const) {
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: tty });
        write.mockClear();
        expect(await runMearlCli(['tab_list', ...flags])).toBe(0);
        const output = String(write.mock.calls[0]?.[0]);
        expect(JSON.parse(output)).toEqual(value);
        expect(output).toBe(JSON.stringify(value, null, compact ? undefined : 2) + '\n');
      }
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it('omits plugins without public commands from CLI discovery without loading their code', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-toolbox-cli-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
    const entry = join(directory, 'main.mjs');
    writeFileSync(entry, "throw new Error('must not load for top-level help');");
    registerPlugin('private-tool', entry, undefined, { hasPublicCommands: false });
    registerPlugin('public-tool', entry, undefined, { hasPublicCommands: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMearlCli(['--help'])).toBe(0);
    expect(String(error.mock.calls[0]?.[0])).toContain('public-tool');
    expect(String(error.mock.calls[0]?.[0])).not.toContain('private-tool');
  });
  it.each([{ flags: [] }, { flags: ['--help'] }])(
    'explains how to open a popup-only plugin without invoking it: $flags',
    async ({ flags }) => {
      const directory = mkdtempSync(join(tmpdir(), 'mearl-popup-guidance-'));
      temporaryDirectories.push(directory);
      vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
      const entry = join(directory, 'main.mjs'),
        page = join(directory, 'assets', 'toolbox', 'index.html');
      mkdirSync(dirname(page), { recursive: true });
      writeFileSync(page, '<!doctype html><html><body>Tool</body></html>');
      writeFileSync(
        entry,
        `export const toolbox={version:1,title:'沉浸式翻译',displayMode:'popup',page:{type:'sandbox',entry:'assets/toolbox/index.html',commands:['start']}};
      export default app=>app.toolboxCommand('start',()=>{throw new Error('must not execute');});`,
      );
      registerPlugin('translate', entry);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke');
      expect(await runMearlCli(['translate', ...flags])).toBe(0);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('请在 Mearl Popup 中打开「沉浸式翻译」使用'),
      );
      expect(invoke).not.toHaveBeenCalled();
    },
  );
  it.each(['task', 'model', 'state', 'page', 'dev'])(
    'routes %s as an ordinary registered plugin',
    async name => {
      const directory = mkdtempSync(join(tmpdir(), 'mearl-plugin-domain-'));
      temporaryDirectories.push(directory);
      vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
      const entry = join(directory, 'main.mjs');
      writeFileSync(
        entry,
        `export default app => app.command('current', () => ({ business: ${JSON.stringify(name)} }));`,
      );
      registerPlugin(name, entry);
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      expect(await runMearlCli([name, 'current'])).toBe(0);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({ business: name });
    },
  );
  it('returns session metadata when the first screenshot is saved to a file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-session-screenshot-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'page.png');
    const session = { sessionId: 'session-fixture', transport: 'provider' };
    vi.spyOn(UnifiedClient.prototype, 'invoke').mockResolvedValue({
      data: Buffer.from('image').toString('base64'),
      session,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(
      await runMearlCli([
        'page_screenshot',
        '--session',
        'new',
        '--payload',
        '{"tabId":7}',
        '--output',
        output,
      ]),
    ).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('image');
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toEqual({ session, outputPath: output });
  });
  it('prints the client version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runMearlCli(['--version'], { clientVersion: '2.6.0' })).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith('2.6.0');
  });

  it('prints usage when no action is provided', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli([], { clientVersion: '2.6.0' })).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('mearl v2.6.0'));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('connector_list'));
    const usage = String(error.mock.calls[0]?.[0]);
    expect(usage).toContain('mearl check [选项]');
    expect(usage).not.toContain('--json');
    expect(usage).toContain('常用选项：');
    for (const command of ['task', 'model', 'state', 'page', 'dev'])
      expect(usage).not.toMatch(new RegExp('^  ' + command + '\\s', 'm'));
    expect(usage).not.toContain('--connector');
    expect(usage).not.toContain('--local');
    expect(usage).not.toContain('--cdp');
    expect(usage).not.toContain('--server');
    expect(usage).toContain('set_app_profile           设置或清除目标标签页的 App 容器模拟');
    expect(usage).not.toContain('页面跳转 iframe 容器栈');
  });

  it('shows registered Providers in top-level help without starting them', async () => {
    registeredProviders.push({
      providerId: 'example-device',
      name: 'Example Device Provider',
      version: '0.2.0',
      packageName: '@example/mearl-provider-device',
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['--help'], { clientVersion: '2.12.0' })).resolves.toBe(0);

    const usage = String(error.mock.calls[0]?.[0]);
    expect(usage).toContain('已注册 Provider：');
    expect(usage).toContain('example-device');
    expect(usage).toContain('Example Device Provider v0.2.0 (@example/mearl-provider-device)');
  });

  it('renders Provider-owned guidance through its namespace', async () => {
    registeredProviders.push({
      providerId: 'example-device',
      name: 'Example Device',
      version: '0.2.0',
      packageName: '@example/mearl-provider-device',
      browserType: {
        name: '真机',
        help: ['扫码连接 Example Device 真机。'],
        inputSchema: {
          type: 'object',
          properties: {
            debugId: { type: 'string', title: '配对码', description: '留空时自动生成' },
            connection: {
              type: 'object',
              title: '连接参数',
              properties: { region: { type: 'string', title: '区域' } },
            },
          },
          oneOf: [
            {
              type: 'object',
              title: '自动配对',
              properties: {},
              not: { type: 'object', required: ['debugId'], properties: {} },
            },
            { type: 'object', title: '复用配对码', required: ['debugId'], properties: {} },
          ],
        },
        configuration: {
          inputSchema: {
            type: 'object',
            required: ['token'],
            properties: { token: { type: 'string', secret: true, title: '访问令牌' } },
          },
        },
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['example-device', '--help'])).resolves.toBe(0);

    const help = String(error.mock.calls[0]?.[0]);
    expect(help).toContain('example-device — Example Device v0.2.0');
    expect(help).toContain('扫码连接 Example Device 真机。');
    expect(help).toContain('debugId');
    expect(help).toContain('region');
    expect(help).toContain('复用配对码（必填：debugId）');
    expect(help).toContain('token');
    expect(help).toContain('敏感');
    expect(help).toContain('mearl browser_manage');
  });

  it('appends commands from a registered same-name plugin to Provider help', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-provider-plugin-help-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
    const entry = join(directory, 'scripts', 'main.mjs');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(
      entry,
      `export default app => {
        app.command('devices [environment]', () => [], '查询远程设备池');
        app.command('doctor', () => ({}), '检查运行环境');
      };`,
    );
    registerPlugin('example-mobile', entry);
    registeredProviders.push({
      providerId: 'example-mobile',
      name: 'Example Mobile',
      version: '0.1.0',
      packageName: '@example/mearl-provider-mobile',
      browserType: {
        name: '真机',
        inputSchema: { type: 'object', properties: {} },
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['example-mobile', '--help'])).resolves.toBe(0);

    const help = String(error.mock.calls[0]?.[0]);
    expect(help).toContain('扩展命令：');
    expect(help).toContain('mearl example-mobile devices [environment]  查询远程设备池');
    expect(help).toContain('mearl example-mobile doctor  检查运行环境');
    expect(help).toContain('mearl example-mobile <command> --help');
  });

  it('prints dedicated help for check', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['check', '--help'])).resolves.toBe(0);
    const help = String(error.mock.calls[0]?.[0]);
    expect(help).toContain('mearl check [选项]');
    expect(help).toContain('--json                输出机器可读 JSON');
    expect(help).toContain('--timeout <seconds>   单项检查超时时间，默认 5 秒');
    expect(help).toContain('--connector <id|名称>');
    expect(help).toContain('--local');
    expect(help).not.toContain('--cdp');
    expect(help).toContain('--server <url>');
    expect(help).toContain('--updates');
    expect(help).not.toContain('API 调试');
    expect(parseClientArgs(['check']).updates).toBe(false);
    expect(parseClientArgs(['check', '--updates']).updates).toBe(true);
  });

  it('shows payload files and common options in action usage', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['page_screenshot', '--help'])).resolves.toBe(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'mearl page_screenshot [--payload <json> | --payload-file <path>] [常用选项]',
      ),
    );
  });

  it('explains nested observation and failure handling without connecting to a browser', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke');

    await expect(runMearlCli(['page_click', '--help'])).resolves.toBe(0);

    const help = String(error.mock.calls.at(-1)?.[0]);
    expect(help).toContain('quietMs: number');
    expect(help).toContain('events: boolean');
    expect(help).toContain('selector / text / point');
    expect(help).toContain('precondition');
    expect(help).toContain('dispatch-uncertain');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows multipart field details and result semantics only for the relevant action', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['send_request', '--help'])).resolves.toBe(0);
    const requestHelp = String(error.mock.calls.at(-1)?.[0]);
    expect(requestHelp).toContain('fieldName: string');
    expect(requestHelp).toContain('contentType: string');
    expect(requestHelp).toContain('bodyType');
    expect(requestHelp).not.toContain('quietMs');

    await expect(runMearlCli(['tab_list', '--help'])).resolves.toBe(0);
    const listHelp = String(error.mock.calls.at(-1)?.[0]);
    expect(listHelp).not.toContain('约束与行为：');
    expect(listHelp).not.toContain('结果：');
    expect(listHelp).not.toContain('contentType');
  });

  it('shows host selectors only for browser inventory and launch help', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['browser_list', '--help'])).resolves.toBe(0);
    const listHelp = String(error.mock.calls.at(-1)?.[0]);
    expect(listHelp).toContain('目标范围（按需）');
    expect(listHelp).toContain('--local');
    expect(listHelp).toContain('--connector <id|名称>');
    expect(listHelp).not.toContain('--cdp');
    expect(listHelp).not.toContain('--server');

    await expect(runMearlCli(['browser_manage', '--help'])).resolves.toBe(0);
    const launchHelp = String(error.mock.calls.at(-1)?.[0]);
    expect(launchHelp).toContain('宿主选择（本机与远端同时可用时）');
    expect(launchHelp).toContain('--local');
    expect(launchHelp).toContain('--connector <id|名称>');
    expect(launchHelp).toContain('--browser <id|名称>');
  });

  it.each([
    ['tab_list', '列出目标浏览器所有窗口中的标签页'],
    ['page_screenshot', '获取当前视口或指定元素截图'],
    ['page_frames', '获取页面主 frame 与所有 iframe 列表'],
  ])('describes %s according to its actual scope', async (action, description) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli([action, '--help'])).resolves.toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(description));
  });

  it('keeps connector_list available as an explicit advanced command', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['connector_list', '--help'])).resolves.toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('高级诊断'));
  });

  it('does not recommend connector_list for similar unknown commands', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['connector', 'list'])).resolves.toBe(2);
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('connector_list'));
  });

  it('keeps capture_checkpoint as an alias for tab_checkpoint help', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['capture_checkpoint', '--help'])).resolves.toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('tab_checkpoint'));
  });

  it('prints machine-readable JSON for check --json', async () => {
    vi.spyOn(UnifiedClient.prototype, 'invoke').mockImplementation(async action => {
      if (action === 'browser_list') {
        return {
          connectedCount: 1,
          defaultBrowserId: 'mearl:local:extension-a',
          browsers: [
            {
              browserId: 'mearl:local:extension-a',
              name: 'Chrome',
              status: 'connected',
              transport: 'extension',
            },
          ],
        };
      }
      if (action === 'get_versions') {
        return {
          nativeHost: '2.8.0',
          extension: '2.8.0',
          extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
          setupManagedPath: '/home/test/.mearl/chrome-extension',
        };
      }
      throw new Error(`unexpected ${action}`);
    });
    vi.spyOn(UnifiedClient.prototype, 'disconnect').mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runMearlCli(['check', '--local', '--json'])).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"setupManagedPath"'));
    expect(write).not.toHaveBeenCalledWith(expect.stringContaining('"updates"'));
  });

  it('rejects --json for ordinary actions whose output is already JSON', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['tab_list', '--json'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith('--json 仅适用于 check');
  });

  it('recommends executable examples for a similar multi-word command', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['tab', 'new'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('不支持的命令: tab new'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`mearl tab_open --payload '{"url":"https://example.com"}'`),
    );
  });

  it('recommends a canonical action for a typo without connecting to a browser', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['page_clikc'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('mearl page_click'));
  });

  it.each([
    ['page_fill', 'page_type', '"clearFirst":true'],
    ['page_select', 'page_click', '"role":"option"'],
    ['page_reload', 'page_navigate', '"refresh":true'],
    ['tab_activate', 'tab_open', '"active":true'],
  ])('keeps %s suggestion-only and supplies a suitable payload', async (input, action, payload) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke');
    await expect(runMearlCli([input, '--help'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`mearl ${action} --payload`));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(payload));
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['--help', '-h'])(
    'prints internal reload help for %s without dispatching',
    async flag => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke');
      await expect(runMearlCli(['__extension_reload', flag])).resolves.toBe(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('重载目标浏览器中的 Mearl 扩展'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('--browser'));
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('describes internal passthrough without claiming that the host supports an unknown action', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke');
    await expect(runMearlCli(['__unknown_internal_action', '--help'])).resolves.toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('是否支持及参数要求由目标宿主决定'));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the generic help fallback for unrelated commands', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['totally-unrelated'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(
      'PLUGIN_NOT_REGISTERED: 不支持的命令: totally-unrelated\n运行 mearl --help 查看所有可用命令',
    );
  });

  it('returns a non-zero exit code for a structured page action failure', async () => {
    vi.spyOn(UnifiedClient.prototype, 'invoke').mockResolvedValue({
      action: {
        name: 'page_click',
        success: false,
        error: 'Ref @e9801 not found. Run page_snapshot first to get fresh refs.',
        stage: 'precondition',
      },
    });
    vi.spyOn(UnifiedClient.prototype, 'disconnect').mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      runMearlCli(['page_click', '--payload', '{"tabId":7,"selector":"@e9801"}']),
    ).resolves.toBe(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[0])).action).toMatchObject({
      success: false,
      stage: 'precondition',
    });
  });

  it('returns a non-zero exit code when run_actions stops on a failed step', async () => {
    vi.spyOn(UnifiedClient.prototype, 'invoke').mockResolvedValue({
      results: [
        { step: 0, action: 'page_click', success: true, data: { clicked: true } },
        { step: 1, action: 'page_click', success: false, error: 'Element not found' },
      ],
      completedSteps: 1,
      totalSteps: 3,
      failedStep: 1,
      error: 'Element not found',
    });
    vi.spyOn(UnifiedClient.prototype, 'disconnect').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      runMearlCli(['run_actions', '--payload', '{"tabId":7,"actions":[]}']),
    ).resolves.toBe(1);
  });

  it('prints an explicit error when a page action omits tabId', async () => {
    vi.spyOn(UnifiedClient.prototype, 'disconnect').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['page_click', '--payload', '{"selector":"#submit"}'])).resolves.toBe(
      1,
    );
    expect(error).toHaveBeenCalledWith(
      'page_click requires a numeric tabId. Call tab_open or tab_list to obtain a tabId.',
    );
  });

  it.each([
    '请求超时，已等待 15 秒',
    'Request timeout after 15s',
    'CDP command timed out',
    'CDP command timeout: Runtime.evaluate',
  ])('gives recovery guidance for an action timeout without retrying: %s', async message => {
    const invoke = vi
      .spyOn(UnifiedClient.prototype, 'invoke')
      .mockRejectedValue(new Error(message));
    const disconnect = vi
      .spyOn(UnifiedClient.prototype, 'disconnect')
      .mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      runMearlCli(['page_click', '--payload', '{"tabId":7,"selector":"#submit"}']),
    ).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith(message);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('先读取当前状态确认结果'));
    expect(invoke).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it('directs a connection timeout to diagnostics without action retry guidance', async () => {
    vi.spyOn(UnifiedClient.prototype, 'invoke').mockRejectedValue(
      new Error('Connection timeout after 5s'),
    );
    vi.spyOn(UnifiedClient.prototype, 'disconnect').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runMearlCli(['tab_list'])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('运行 mearl check'));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('超时不代表动作未执行'));
  });
});

describe('parseClientArgs', () => {
  it('supports inline values and keeps the action first', () => {
    expect(
      parseClientArgs([
        'page_click',
        '--payload={"selector":"#submit"}',
        '--timeout=5',
        '--compact',
      ]),
    ).toMatchObject({
      action: 'page_click',
      compact: true,
      payload: { selector: '#submit' },
      timeoutSec: 5,
    });
  });

  it('strictly rejects unknown options, missing values, and extra positionals', () => {
    expect(() => parseClientArgs(['tab_list', '--unknown'])).toThrow('unknown option');
    expect(() => parseClientArgs(['tab_list', '--timeout'])).toThrow('argument missing');
    expect(() => parseClientArgs(['tab_list', 'extra'])).toThrow('too many arguments');
  });

  it('parses plugin business options without weakening built-in option validation', () => {
    expect(
      parseClientArgs(
        [
          'identity',
          'request',
          'https://api.example.com/v1/items',
          'ata',
          '--auth=ticket-header',
          '--responseType=json',
        ],
        true,
      ),
    ).toMatchObject({
      action: 'identity',
      pluginArgs: ['request', 'https://api.example.com/v1/items', 'ata'],
      pluginInput: {
        auth: 'ticket-header',
        responseType: 'json',
      },
    });
    expect(() =>
      parseClientArgs(
        ['identity', 'request', 'https://api.example.com/v1/items', 'ata', '--auth'],
        true,
      ),
    ).toThrow('argument missing');
    expect(
      parseClientArgs(
        [
          'identity',
          'request',
          'https://api.example.com/v1/items',
          'ata',
          '--auth',
          'ticket-query',
        ],
        true,
      ),
    ).toMatchObject({ pluginInput: { auth: 'ticket-query' } });
    expect(() =>
      parseClientArgs(
        ['identity', '--payload', '{"command":"whoami","input":{}}', '--auth=id-token'],
        true,
      ),
    ).toThrow('不能与 --payload 同时使用');
    expect(() => parseClientArgs(['tab_list', '--auth=id-token'])).toThrow('unknown option');
  });

  it('keeps the control session as a host option for plugin payloads and business options', () => {
    for (const args of [
      ['jev', '--session', 's_test', '--payload', '{"command":"run","input":{"tabId":123}}'],
      ['jev', 'run', 'Set the form', '--session=s_test', '--tabId=123'],
    ]) {
      const parsed = parseClientArgs(args, true);
      expect(parsed.session).toBe('s_test');
      expect(parsed.pluginInput ?? {}).not.toHaveProperty('session');
    }
  });

  it('accepts plugin JSON compatibility flags and preserves underscored adapter arguments', () => {
    expect(
      parseClientArgs(
        ['bbrowser', 'site', 'example/search', '--seller_id', '123', '--json', '--local'],
        true,
      ),
    ).toMatchObject({
      action: 'bbrowser',
      pluginArgs: ['site', 'example/search'],
      pluginInput: { seller_id: '123' },
      json: true,
      local: true,
    });
    expect(() => parseClientArgs(['tab_list', '--seller_id', '123'])).toThrow('unknown option');
    expect(() => parseClientArgs(['tab_list', '--cdp'])).toThrow('unknown option');
  });

  it('passes a bare --all flag as a boolean plugin input', () => {
    expect(parseClientArgs(['headers', 'browser-header', 'inject', '--all'], true)).toMatchObject({
      pluginArgs: ['browser-header', 'inject'],
      pluginInput: { all: true },
    });
    expect(() => parseClientArgs(['tab_list', '--all'])).toThrow('unknown option');
    expect(() =>
      parseClientArgs(
        [
          'headers',
          '--payload',
          '{"command":"browser-header","input":{"operation":"inject"}}',
          '--all',
        ],
        true,
      ),
    ).toThrow('不能与 --payload 同时使用');
  });

  it('preserves business-level option validation', () => {
    expect(() =>
      parseClientArgs(['tab_list', '--payload', '{}', '--payload-file', './payload.json']),
    ).toThrow('不能同时使用');
    expect(() => parseClientArgs(['tab_list', '--local', '--connector', 'remote-a'])).toThrow(
      '不能与 --connector 同时使用',
    );
  });

  it('promotes page_screenshot payload.output to the CLI output path', () => {
    expect(
      parseClientArgs([
        'page_screenshot',
        '--payload',
        '{"tabId":7,"format":"png","output":"/tmp/page.png"}',
      ]),
    ).toMatchObject({
      action: 'page_screenshot',
      outputPath: '/tmp/page.png',
      payload: { tabId: 7, format: 'png' },
    });
  });

  it('rejects conflicting page_screenshot output paths', () => {
    expect(() =>
      parseClientArgs([
        'page_screenshot',
        '--payload',
        '{"output":"/tmp/payload.png"}',
        '--output',
        '/tmp/option.png',
      ]),
    ).toThrow('payload.output 不能与 --output 同时使用');
  });
});
