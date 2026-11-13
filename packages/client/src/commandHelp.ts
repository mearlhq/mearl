import { COMMANDS, COMMAND_MAP, type CommandDef } from './commands.js';
import { SDK_METHOD_ACTIONS, SDK_OPTIONS_ONLY_METHODS } from './sdkMethods.js';
import { listPluginNames } from './plugins/pluginRegistry.js';

const HELPER_HELP: Record<string, string> = {
  invoke: 'invoke(action, payload?, options?) — 调用浏览器 action，返回普通 action 的原始结果',
  invokePlugin:
    'invokePlugin(name, { command, input }, options?) — 调用已注册 Skill 命令，返回该命令的原始结果',
  help: 'help(methodOrAction?) / help({ plugin, command? }) — 返回共享命令帮助文本；无参数时列出方法；用 console.log 输出',
  structure:
    'structure(value, { maxDepth=5, maxKeys=50, arraySamples=1, maxNodes=2000 }?) — 同步返回有界结构样本；叶子值替换为类型，标注数组样本、循环引用和截断；不能证明未采样内容或业务语义',
  saveArtifact: 'saveArtifact(artifact, absolutePath, options?) — 保存浏览器文件产物，返回保存结果',
  selectBrowser:
    'selectBrowser({ browser? }, options?) — 选择默认目标；返回 { selected }；browser 使用 browserList 返回的 ID 或名称，空字符串清除默认目标',
};

export function getCommandHelp(target?: string): string {
  if (!target)
    return [
      ...COMMANDS.map(
        (command: CommandDef) =>
          `${[...SDK_METHOD_ACTIONS].find(([, action]) => action === command.name)?.[0] ?? command.name} (${command.name}) — ${command.summary ?? command.description}`,
      ),
      ...Object.values(HELPER_HELP),
      ...listPluginNames().map(plugin => `Skill ${plugin} — help({ plugin: '${plugin}' })`),
    ].join('\n');
  if (Object.hasOwn(HELPER_HELP, target)) return HELPER_HELP[target];
  const resolved = SDK_METHOD_ACTIONS.get(target) ?? target;
  const action = resolved === 'capture_checkpoint' ? 'tab_checkpoint' : resolved;
  if (action === 'browser_select_browser') return HELPER_HELP.selectBrowser;
  const command = COMMAND_MAP.get(action);
  if (!command) throw new Error(`Unknown command or SDK method: ${target}`);
  return formatCommandHelp('mearl', command);
}

export function formatCommandHelp(commandName: string, command: CommandDef): string {
  const payloadUsage = command.params?.length ? ' [--payload <json> | --payload-file <path>]' : '';
  const lines = [
    `${command.name}`,
    `  ${command.description}`,
    '',
    '用法：',
    `  ${commandName} ${command.name}${payloadUsage} [常用选项]`,
    '',
  ];
  const method = [...SDK_METHOD_ACTIONS].find(([, action]) => action === command.name)?.[0];
  if (method)
    lines.push(
      'SDK：',
      ...(method === 'browserList'
        ? [`  await mearl.${method}(options?)`, `  await mearl.${method}(params, options)`]
        : [
            `  await mearl.${method}(${SDK_OPTIONS_ONLY_METHODS.has(method) ? 'options?' : 'params, options?'})`,
          ]),
      '',
    );
  if (command.params?.length) {
    lines.push('参数（--payload JSON 字段）：');
    for (const parameter of command.params) {
      const required = parameter.required ? '必填' : '可选';
      lines.push(
        `  ${parameter.name.padEnd(22)}${required.padEnd(6)}${parameter.type.padEnd(28)}  ${parameter.description}`,
      );
      for (const detail of parameter.details ?? []) lines.push(`    ${detail}`);
    }
    lines.push('');
  }
  if (command.name === 'browser_list' || command.name === 'session_list') {
    lines.push(
      '目标范围（按需）：',
      '  --local               只列出当前机器上的浏览器',
      '  --connector <id|名称> 只列出指定远端 connector 的浏览器',
      '',
    );
  } else if (command.name === 'browser_manage') {
    lines.push(
      '宿主选择（本机与远端同时可用时）：',
      '  --local               在当前机器启动或接入',
      '  --connector <id|名称> 在指定远端 connector 启动或接入',
      '  --browser <id|名称>   在控制浏览器所在宿主启动，并可作为 Cookie/UA 来源',
      '',
    );
  }
  if (command.notes?.length) {
    lines.push('约束与行为：', ...command.notes.map(note => `  ${note}`), '');
  }
  if (command.result?.length) {
    lines.push('结果：', ...command.result.map(line => `  ${line}`), '');
  }
  if (command.examples?.length) {
    lines.push('示例：');
    for (const example of command.examples) lines.push(`  ${commandName} ${example}`);
  }
  lines.push('', `运行 ${commandName} --help 查看常用选项。`);
  return lines.join('\n');
}
