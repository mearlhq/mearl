import { createCommands } from './commands.mjs';

export const name = 'tinypng';
export const description = '通过 TinyPNG 压缩 PNG、JPEG 和 WebP 图片';
export const toolbox = {
  version: 1,
  title: '图片压缩',
  description: '粘贴、拖入或选择图片，压缩后下载',
  icon: 'package',
  locales: { en: { title: 'Image compression', description: 'Paste, drop or choose images to compress and download' } },
  page: {
    type: 'sandbox', runtime: 'preact', entry: 'assets/toolbox/index.html',
    commands: ['list', 'begin', 'append', 'compress', 'compress-batch', 'resource-chunk', 'release-resource', 'remove'],
  },
  order: 95,
};

export default function register(app) {
  const commands = createCommands(app.invoke);
  app.toolboxCommand('list', commands.list, '读取本地压缩列表');
  app.toolboxCommand('begin', commands.begin, '开始分块导入图片');
  app.toolboxCommand('append', commands.append, '追加图片分块');
  app.toolboxCommand('compress', commands.compress, '上传图片至 TinyPNG 并保存结果信息');
  app.toolboxCommand('compress-batch', commands.compressBatch, '依次压缩已导入的图片并返回各项结果');
  app.toolboxCommand('resource-chunk', commands.resourceChunk, '读取压缩图片分块');
  app.toolboxCommand('release-resource', commands.releaseResource, '释放本次图片读取的临时数据');
  app.toolboxCommand('remove', commands.remove, '删除列表与任务数据，不删除原始文件');
  app.command('file', commands.file, '压缩执行宿主的 filePath，保存到指定 outputPath');
}
