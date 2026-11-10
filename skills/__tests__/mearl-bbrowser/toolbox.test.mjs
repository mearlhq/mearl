// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(join(process.cwd(), 'package.json'));
const preact = require('preact'), hooks = require('preact/hooks'), htm = require('htm');
const root = join(process.cwd(), 'skills/mearl-bbrowser/assets/toolbox');
const adapter = { name: 'demo/search', file: "/tmp/site's/search.js", domain: 'example.test', source: 'local', description: 'Search demo', args: { query: { required: true }, count: 'Result count' } };
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
const type = (index, value) => { const node = document.querySelectorAll('.fields textarea, .fields input')[index]; node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); };
afterEach(() => { preact.render(null, document.getElementById('app')); document.body.innerHTML = ''; delete window.mearl; delete window.bbrowserCommand; });
async function mount() {
  document.body.innerHTML = '<div id="app"></div>';
  const invoke = vi.fn(async command => {
    if (command === 'catalog') return { installed: false, adapters: [adapter] };
    if (command === 'execute') return { result: { ok: true } };
    if (command === 'host.task.start') return { taskId: 'install' };
  });
  let changeLocale;
  window.mearl = { ready: async () => ({ locale: 'zh_CN' }), invoke, waitTask: vi.fn(async () => ({})), ui: { ...preact, ...hooks, html: htm.bind(preact.h) }, onContextChange(callback) { changeLocale = callback; return () => {}; } };
  for (const file of ['command.js', 'app.js']) {
    await import(`data:text/javascript;base64,${Buffer.from(await readFile(join(root, file))).toString('base64')}#${Math.random()}`);
  }
  await vi.waitFor(() => expect(document.querySelector('.adapter')).not.toBeNull());
  document.querySelector('.adapter').click();
  await vi.waitFor(() => expect(document.querySelector('.fields')).not.toBeNull());
  return { invoke, changeLocale: value => changeLocale({ locale: value }) };
}
it('copies shell-safe arguments and executes exactly the selected file, retaining drafts across locale changes', async () => {
  const { invoke, changeLocale } = await mount();
  expect(button('执行').disabled).toBe(true);
  const query = 'a\'b "x" $(echo unsafe) `whoami`\n中文';
  type(0, query); type(1, '0'); type(2, '42');
  await vi.waitFor(() => expect(button('执行').disabled).toBe(false));
  document.querySelector('.command-copy').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('host.clipboard.writeText', expect.anything()));
  const copied = invoke.mock.calls.find(([command]) => command === 'host.clipboard.writeText')[1].text;
  const argv = execFileSync('/bin/sh', ['-c', copied.replace('mearl bbrowser site ', "printf '%s\\0' ")], { encoding: 'utf8' }).split('\0').slice(0, -1);
  expect(argv).toEqual([adapter.name, query, '0', '--tab', '42']);
  const input = { tokens: ['run', adapter.file], args: { query, count: '0' }, tab: 42 };
  await vi.waitFor(() => expect(button('执行').disabled).toBe(false));
  changeLocale('en');
  await vi.waitFor(() => expect(button('Execute')).toBeDefined());
  expect(document.querySelector('.fields textarea').value).toBe(query);
  button('Execute').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('execute', input));
});
it('uses short names and keeps sparse or option-like arguments unambiguous', async () => {
  await mount();
  expect(window.bbrowserCommand({ ...adapter, name: 'zhihu/me', args: {} }, {}, '').text).toBe('mearl bbrowser site zhihu/me');
  expect(window.bbrowserCommand(adapter, { query: 'topic', count: '10' }, '').text).toBe('mearl bbrowser site demo/search topic 10');
  for (const args of [{ count: '10' }, { query: '--help' }]) {
    const command = window.bbrowserCommand(adapter, args, '');
    const payload = execFileSync('/bin/sh', ['-c', command.text.replace('mearl bbrowser --payload ', "printf '%s' ")], { encoding: 'utf8' });
    expect(JSON.parse(payload)).toEqual({ command: 'site', input: { tokens: ['run', adapter.name], args } });
  }
});
it('retains arguments on business errors, validates tab IDs and does not retry execution', async () => {
  const { invoke } = await mount();
  type(0, 'topic'); type(2, '-1');
  await vi.waitFor(() => expect(button('执行').disabled).toBe(true));
  type(2, '');
  await vi.waitFor(() => expect(button('执行').disabled).toBe(false));
  invoke.mockImplementation(async () => ({ success: false, error: { message: 'Please log in' }, result: { error: 'Please log in' } }));
  button('执行').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('host.toast', { message: 'Please log in', type: 'error' }));
  expect(document.querySelector('.fields textarea').value).toBe('topic');
  expect(invoke.mock.calls.filter(([command]) => command === 'execute')).toHaveLength(1);
});
it('installs through a background task and reloads the catalog after completion', async () => {
  const { invoke } = await mount();
  button('安装社区库').click();
  await vi.waitFor(() => expect(window.mearl.waitTask).toHaveBeenCalledWith('install', expect.anything()));
  await vi.waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'catalog')).toHaveLength(2));
  expect(invoke).toHaveBeenCalledWith('host.task.start', expect.objectContaining({ command: 'site', input: { tokens: ['update'] } }));
});

it('shows loading on the trigger and reports transport failures through the host toast without inserting layout rows', async () => {
  const { invoke } = await mount();
  type(0, 'topic');
  await vi.waitFor(() => expect(button('执行').disabled).toBe(false));
  let reject;
  invoke.mockImplementation(command => command === 'execute' ? new Promise((_, fail) => { reject = fail; }) : Promise.resolve());
  button('执行').click();
  await vi.waitFor(() => expect(button('执行').getAttribute('aria-busy')).toBe('true'));
  expect(button('执行').querySelector('.spinning')).not.toBeNull();
  reject(new Error('Transport unavailable'));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('host.toast', { message: 'Transport unavailable', type: 'error' }));
  await vi.waitFor(() => expect(button('执行').getAttribute('aria-busy')).toBe('false'));
  expect(document.querySelector('[role=status], [role=alert]')).toBeNull();
  expect(button('执行').disabled).toBe(false);
});
