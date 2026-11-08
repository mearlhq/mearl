import { invokeNotesStore } from './store.mjs';

export const name = 'notes';
export const description = '管理记事本和跨会话 Agent 记忆';

export const toolbox = {
  version: 1,
  title: '记事本',
  description: '随手记录，并让 Agent 记住重要信息',
  icon: 'notebook-pen',
  locales: { en: { title: 'Notes', description: 'Write notes and manage persistent Agent memory' } },
  page: {
    type: 'sandbox', runtime: 'preact', entry: 'assets/toolbox/index.html',
    commands: ['page-list', 'get', 'create', 'update', 'delete', 'restore', 'purge', 'empty-trash', 'tabs', 'image-begin', 'image-append', 'image-cancel', 'image-chunk', 'image-remove'],
  },
  order: 60,
};

function agentSummary(note) {
  const lines = note.excerpt.trim().split('\n');
  if (lines[0].replace(/^#+\s*/, '').trim() === note.title.trim()) lines.shift();
  const excerpt = lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    id: note.id, title: note.title,
    ...(excerpt ? { excerpt } : {}),
    ...(note.project ? { project: note.project } : {}),
    ...(note.images.length ? { imageCount: note.images.length } : {}),
  };
}

export default function register(app) {
  app.toolboxCommand('tabs', async () => {
    const { tabs } = await app.invoke('tab_list', {});
    return { tabs: tabs.filter(tab => /^https?:\/\//.test(tab.url)).map(({ id, title, url }) => ({ id, title, url })) };
  }, '列出可收录的网页标题和链接');
  app.toolboxCommand('page-list', input => invokeNotesStore({ operation: 'list', input }), '读取工具箱笔记列表');
  for (const command of ['restore', 'purge', 'empty-trash', 'image-begin', 'image-append', 'image-cancel', 'image-chunk', 'image-remove']) {
    app.toolboxCommand(command, input => invokeNotesStore({ operation: command, input }), '管理回收站或本地图片附件');
  }
  for (const [command, signature, description] of [
    ['list', 'list', '列出笔记短摘要，默认 10 条；支持 query、scope、project、offset、limit'],
    ['search', 'search [query]', '检索个人与当前 project 的有效记忆，默认 10 条'],
  ]) {
    app.command(signature, async input => {
      const result = await invokeNotesStore({ operation: command, input: { ...input, limit: input?.limit ?? 10 } });
      return { notes: result.notes.map(agentSummary), total: result.total, ...(result.nextOffset !== null ? { nextOffset: result.nextOffset } : {}) };
    }, description);
  }
  for (const [command, signature, description] of [
    ['get', 'get <id>', '读取正文；记忆检索传 memoryOnly=true 和当前 project'],
    ['create', 'create <title>', '记录笔记或记忆，正文通过 --payload 传入'],
    ['update', 'update <id>', '更新笔记；必须传 revision，未提供的内容保持原值'],
    ['delete', 'delete <id>', '忘掉笔记并移入回收站；必须传 revision'],
  ]) {
    app.command(signature, input => invokeNotesStore({ operation: command, input }), description);
  }
}
