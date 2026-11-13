import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { executeScript } from './script.js';

export async function runScriptCli(args: string[], commandName: string): Promise<number> {
  const program = new Command()
    .name(`${commandName} run`)
    .description('执行 Node.js 脚本；预注入 mearl SDK，支持顶层 await、条件和循环')
    .option('--file <path>', '读取 JavaScript 文件；省略时从 stdin 读取')
    .option('--session <new-or-id>', '首次建立或复用控制会话')
    .option('--browser <id-or-name>', '指定浏览器')
    .option('--connector <id-or-name>', '限制到远端 connector')
    .option('--local', '仅使用本机浏览器')
    .option('--server <url>', '覆盖 cloud-server 地址')
    .option('--timeout <seconds>', '整个脚本的执行时限（默认 60 秒）', '60')
    .allowExcessArguments(false)
    .exitOverride()
    .addHelpText(
      'after',
      `\n示例：\n  ${commandName} run --file task.mjs\n  ${commandName} run <<'JS'\n  console.log(await mearl.tabList());\n  JS\n\n脚本拥有当前宿主的 Node.js 权限；使用 await import() 加载模块。\n调用 Skill 命令：await mearl.invokePlugin('notes', { command: 'search', input: { query: 'project' } })。\n用 console.log(await mearl.help('pageClick')) 查询共享帮助，mearl.structure(value) 查看结果结构。\n每次运行重建 JS 变量；复用 session 和 tabId 可继续同一浏览器任务。\n`,
    );
  let source: string;
  let options: ReturnType<typeof program.opts>;
  try {
    program.parse(args, { from: 'user' });
    options = program.opts();
    const timeout = Number(options.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)
      throw new Error('--timeout 必须是有效范围内的大于 0 的秒数');
    if (options.local && options.connector) throw new Error('--local 不能与 --connector 同时使用');
    if (options.file) source = await readFile(resolve(options.file), 'utf8');
    else {
      if (process.stdin.isTTY) throw new Error('通过 stdin 提交脚本，或使用 --file <path>');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 1024 * 1024) throw new Error('脚本不能超过 1 MiB');
        chunks.push(buffer);
      }
      source = Buffer.concat(chunks).toString('utf8');
    }
    if (!source.trim() || Buffer.byteLength(source) > 1024 * 1024)
      throw new Error('脚本必须是非空且不超过 1 MiB 的 JavaScript');
  } catch (error) {
    if ((error as { code?: string }).code === 'commander.helpDisplayed') return 0;
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const result = await executeScript(source, {
      executionTimeoutSec: Number(options.timeout),
      signal: controller.signal,
      source: 'cli',
      ...(options.session ? { session: options.session } : {}),
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.connector ? { connector: options.connector } : {}),
      ...(options.local ? { local: true } : {}),
      ...(options.server ? { serverUrl: options.server } : {}),
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.session) console.error(JSON.stringify({ session: result.session }));
    if (!result.success)
      console.error(
        JSON.stringify({
          error: result.error,
          executionStopped: result.executionStopped,
          mayHaveLateEffects: result.mayHaveLateEffects,
          pendingActions: result.pendingActions,
        }),
      );
    return result.success ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
