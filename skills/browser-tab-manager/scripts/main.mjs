import { summarizeTabs, groupTabs, smartGroupTabs, closeMearlTabs, removeGroup, closeGroup } from './tabs.mjs';

export const name = 'tabs';
export const description = '管理浏览器标签分组并关闭 Mearl 受控标签页';

export const toolbox = {
  version: 1,
  title: '标签管理',
  description: '整理和管理标签分组，关闭 Mearl 受控标签页',
  icon: 'app-window',
  locales: {
    en: {
      title: 'Tab Manager',
      description: 'Organize and manage tab groups, and close Mearl controlled tabs',
    },
  },
  page: {
    type: 'sandbox',
    entry: 'assets/toolbox/index.html',
    commands: ['summary', 'smart-group', 'group', 'remove-group', 'close-group', 'close-mearl'],
  },
  order: 80,
};

export default function register(app) {
  app.command('summary', input => summarizeTabs(input, app.invoke), '统计标签页和 Mearl 受控网页数量');
  app.command('group', input => groupTabs(input, app.invoke), '按指定方案批量分组标签页', [
    `--payload '{"command":"group","input":{"groups":[{"title":"项目文档","tabIds":[123,124]}]}}'`,
  ]);
  app.command('smart-group', input => smartGroupTabs(input, app.invoke, app.progress, app.model), '一次性 Agent 规划并执行标签页分组');
  app.command('remove-group', input => removeGroup(input, app.invoke), '取消分组并保留组内标签页；用 --payload 传 summary 返回的分组字段');
  app.command('close-group', input => closeGroup(input, app.invoke), '关闭分组及组内全部标签页；用 --payload 传 summary 返回的分组字段');
  app.command('close-mearl', input => closeMearlTabs(input, app.invoke, app.progress), '关闭 Mearl 受控标签页');
}
