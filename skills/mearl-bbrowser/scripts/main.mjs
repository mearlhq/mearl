import { adapterDirectories, findAdapter, listAdapters, updateAdapters } from './catalog.mjs';
import { executeAdapter, resolveArguments } from './runtime.mjs';
import { existsSync } from 'node:fs';

export const name = 'bbrowser';
export const description = '通过 Mearl 扩展或 CDP 运行 bb-browser 站点适配器';

export const toolbox = {
  version: 1, title: '站点适配器', description: '浏览、安装和试用 bb-browser 站点适配器', icon: 'globe',
  locales: { en: { title: 'Site adapters', description: 'Browse, install and try bb-browser site adapters' } },
  page: { type: 'sandbox', runtime: 'preact', entry: 'assets/toolbox/index.html', commands: ['site', 'catalog', 'execute'] },
};

const help = {
  usage: 'mearl bbrowser site <name> [args...] [--tab <tabId>]',
  commands: ['site list', 'site search <query>', 'site info <name>', 'site update', 'site <name> [args...]', 'site run <name> [args...]'],
  directories: adapterDirectories().sources,
};

export default function register(app) {
  app.toolboxCommand('catalog', () => ({
    installed: existsSync(adapterDirectories().community), adapters: listAdapters(),
  }), '读取工具箱站点列表与社区库安装状态');
  const runSite = async (input, browserBound = false) => {
    const { tokens = [], tab, args = {}, ...named } = input;
    if (!Array.isArray(tokens) || tokens.some(value => typeof value !== 'string')) throw new Error('tokens 必须是字符串数组');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args 必须是参数对象');
    const [operation, ...rest] = tokens;
    if (!operation) return help;
    if (operation === 'update') {
      if (rest.length || tab !== undefined || Object.keys(args).length || Object.keys(named).length) throw new Error('site update 不接受业务选项或位置参数');
      return updateAdapters(app.progress);
    }
    const describe = ({ file, directory: sourceDirectory, ...meta }) => ({
      ...meta, file,
      ...(meta.example ? { example: meta.example.replace(/^bb-browser\b/, 'mearl bbrowser') } : {}),
    });
    if (operation === 'list' || operation === 'search' || operation === 'info') {
      if (tab !== undefined || Object.keys(args).length || Object.keys(named).length) throw new Error(`site ${operation} 不接受适配器参数`);
      if (operation === 'list') {
        if (rest.length) throw new Error('site list 不接受位置参数；请用 site search <query>');
        return listAdapters().map(describe);
      }
      if (rest.length !== 1) throw new Error(`用法: mearl bbrowser site ${operation} <${operation === 'search' ? 'query' : 'name'}>`);
      if (operation === 'search') {
        const query = rest[0].toLowerCase();
        return listAdapters().filter(adapter => `${adapter.name} ${adapter.description} ${adapter.domain}`.toLowerCase().includes(query)).map(describe);
      }
      const found = findAdapter(rest[0]);
      if (!found) throw new Error(`未找到适配器: ${rest[0]}`);
      return describe(found);
    }
    const [adapterName, ...positional] = operation === 'run' ? rest : tokens;
    const adapter = findAdapter(adapterName);
    if (!adapter) throw new Error(`未找到适配器: ${adapterName ?? ''}；用 site list 查看，或用 site update 下载社区适配器`);
    for (const key of Object.keys(named)) {
      if (Object.hasOwn(args, key)) throw new Error(`参数不能重复传入: ${key}`);
    }
    return executeAdapter(adapter, resolveArguments(adapter, positional, { ...args, ...named }), { invoke: app.invoke, options: app.options, tabId: tab, browserBound });
  };
  app.toolboxCommand('execute', input => runSite(input, true), '在工具箱当前浏览器中执行适配器');
  app.command('site [tokens...]', input => runSite(input), '兼容 bb-browser site：list / search / info / update / run；支持 tab 和适配器命名参数。宿主选项同名参数通过 payload 的 args 对象传入', [
    'site example-shop/whoami',
    'site info zhihu/hot',
    'site zhihu/hot 10',
    'site update',
    `--payload '{"command":"site","input":{"tokens":["zhihu/hot"],"args":{"count":"10"}}}'`,
  ]);
}
