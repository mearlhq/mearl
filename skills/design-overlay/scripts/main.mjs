export { stateStorage } from './state.mjs';
export { pageRuntime } from './commands.mjs';
import { createCommands } from './commands.mjs';

export const name = 'overlay';
export const description = '在网页上叠加设计稿并进行像素对比';
export const toolbox = {
  version: 1,
  displayMode: 'popup',
  title: '设计稿对比',
  description: '叠加 SVG、PNG、JPG，调整位置与裁切并查看像素差异',
  icon: 'layers',
  locales: { en: { title: 'Design Overlay', description: 'Overlay SVG, PNG or JPG designs and compare pixel differences' } },
  page: {
    type: 'sandbox', runtime: 'preact', entry: 'assets/toolbox/index.html',
    commands: ['state', 'update', 'apply', 'clear', 'pick', 'cancel-pick', 'capture', 'begin-import', 'import-chunk', 'resource-chunk'],
  },
  order: 90,
};

export default function register(app) {
  const commands = createCommands(app);
  app.command('tabs', commands.tabs, '列出可对比的网页');
  app.command('state', commands.state, '读取或恢复目标网页的覆盖层');
  app.command('update', commands.update, '更新覆盖层显示、位置和裁切');
  app.command('apply', commands.apply, '把已导入的设计稿应用到目标网页');
  app.command('clear', commands.clear, '清除目标网页的设计稿');
  app.toolboxCommand('pick', commands.pick, '在网页中选择锚定元素');
  app.toolboxCommand('cancel-pick', commands.cancelPick, '取消锚定元素选择');
  app.toolboxCommand('capture', commands.capture, '隐藏覆盖层后截图并返回分块资源');
  app.runtimeCommand('initialize', commands.initialize, '按页面文档读取设计稿设置并初始化');
  app.runtimeCommand('sync', commands.sync, '保存会话内的覆盖层设置');
  app.toolboxCommand('begin-import', commands.beginImport, '开始分块导入设计稿');
  app.toolboxCommand('import-chunk', commands.importChunk, '上传设计稿分块');
  app.toolboxCommand('resource-chunk', commands.resourceChunk, '读取图片或设计稿分块');
  app.command('compare', commands.compare, '计算当前设计稿与网页的像素差异，可用 diffPath 保存 PNG');
  app.command('import', commands.importFile, '从执行宿主的 filePath 导入 SVG、PNG、JPG 并应用到指定网页');
}
