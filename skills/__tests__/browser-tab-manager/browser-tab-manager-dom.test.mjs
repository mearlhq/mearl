// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('tab manager toolbox language', () => {
  it('updates labels and a pending confirmation without fetching or closing tabs', async () => {
    const root = join(process.cwd(), 'skills/browser-tab-manager/assets/toolbox');
    document.body.innerHTML = (await readFile(join(root, 'index.html'), 'utf8'))
      .replace(/<link\b[^>]*>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const invoke = vi.fn(async () => ({ count: 2, mearlCount: 2, groups: [
      { groupId: 1, windowId: 1, title: 'Project', color: 'blue', tabIds: [1, 2] },
    ] }));
    let changeContext;
    window.mearl = {
      ready: async () => ({ locale: 'zh_CN' }), invoke,
      onContextChange: listener => { changeContext = listener; return () => {}; },
    };
    await new Function(`return ${await readFile(join(root, 'app.js'), 'utf8')}`)();
    document.querySelector('[aria-label="关闭「Project」分组及全部标签页"]').click();
    expect(document.querySelector('.group-confirm').textContent).toContain('关闭 2 个标签页？');
    changeContext({ locale: 'en' });
    expect(document.querySelector('.group-confirm').textContent).toContain('Close 2 tabs?');
    expect(document.querySelector('#group-title').textContent).toBe('Smart group');
    expect(document.querySelector('#tab-count').textContent).toBe('2');
    expect(invoke).toHaveBeenCalledOnce();
    changeContext({ locale: 'zh_CN' });
    expect(document.querySelector('.group-confirm').textContent).toContain('关闭 2 个标签页？');
    delete window.mearl;
    document.body.replaceChildren();
  });
});
