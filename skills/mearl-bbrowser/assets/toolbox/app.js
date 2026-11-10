(async () => {
  const bridge = window.mearl, context = await bridge.ready();
  const { html, render, useState, useEffect, useRef } = bridge.ui;
  const messages = {
    zh: { search: '搜索站点、描述或域名', install: '安装社区库', update: '更新社区库', empty: '尚无适配器。安装社区库后即可浏览和试用。', none: '没有匹配的适配器', choose: '选择左侧适配器，填写参数并试用', community: '社区', local: '本地', back: '返回列表', optional: '可选', required: '必填', noArgs: '无需参数', tab: '目标标签页 ID（可选）', auto: '自动匹配站点页面', execute: '执行', copy: '复制命令', copied: '命令已复制', command: '当前命令', result: '执行结果', busy: '处理中…', loaded: '社区库已就绪', failed: '操作失败', note: '使用浏览器当前登录态执行。请先阅读操作说明。', scope: '社区库按整库安装和更新。', readOnly: '声明为只读', write: '可能修改站点数据', unknown: '未声明操作类型' },
    en: { search: 'Search sites, descriptions or domains', install: 'Install community library', update: 'Update library', empty: 'No adapters yet. Install the community library to browse and try them.', none: 'No matching adapters', choose: 'Select an adapter to enter arguments and try it', community: 'Community', local: 'Local', back: 'Back to list', optional: 'Optional', required: 'Required', noArgs: 'No arguments needed', tab: 'Target tab ID (optional)', auto: 'Automatically match a site page', execute: 'Execute', copy: 'Copy command', copied: 'Command copied', command: 'Current command', result: 'Result', busy: 'Working…', loaded: 'Community library is ready', failed: 'Operation failed', note: 'Runs with your browser’s current login. Read the operation description first.', scope: 'The community library is installed and updated as a whole.', readOnly: 'Declared read-only', write: 'May modify site data', unknown: 'Operation type not declared' },
  };
  function App() {
    const [locale, setLocale] = useState(context.locale), [catalog, setCatalog] = useState({ adapters: [], installed: false });
    const [query, setQuery] = useState(''), [selected, setSelected] = useState(null), [values, setValues] = useState({}), [tab, setTab] = useState('');
    const [busy, setBusy] = useState(''), [result, setResult] = useState(null);
    const locked = useRef(false);
    const t = key => messages[String(locale).startsWith('zh') ? 'zh' : 'en'][key];
    const toast = (message, type = 'success') => bridge.invoke('host.toast', { message, type });
    const spinner = action => html`<span class=${`spinner ${busy === action ? 'spinning' : ''}`} aria-hidden="true"></span>`;
    const act = async (action, work) => {
      if (locked.current) return;
      locked.current = true; setBusy(action);
      try { await work(); } catch (e) { if (!e.handledByHost) await toast(e.message || t('failed'), 'error'); }
      finally { locked.current = false; setBusy(''); }
    };
    const loadCatalog = async () => {
      const next = await bridge.invoke('catalog', {});
      setCatalog(next);
      setSelected(current => current ? next.adapters.find(item => item.file === current.file) ?? null : null);
    };
    useEffect(() => { act('load', loadCatalog); return bridge.onContextChange(next => setLocale(next.locale)); }, []);
    const choose = adapter => { setSelected(adapter); setValues({}); setTab(''); setResult(null); };
    const command = selected ? window.bbrowserCommand(selected, values, tab) : null;
    const copyCommand = (action = 'copy') => act(action, async () => {
      await bridge.invoke('host.clipboard.writeText', { text: command.text });
      await toast(t('copied'));
    });
    const invalid = selected && (Object.entries(selected.args).some(([key, definition]) => definition.required && !values[key]) || (tab !== '' && (!/^\d+$/.test(tab) || !Number.isSafeInteger(Number(tab)))));
    const groups = new Map();
    for (const adapter of catalog.adapters.filter(item => `${item.name} ${item.description} ${item.domain}`.toLowerCase().includes(query.toLowerCase()))) {
      const group = adapter.domain || adapter.name.split('/')[0];
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(adapter);
    }
    const execute = () => act('execute', async () => {
      const data = await bridge.invoke('execute', command.input);
      if (data.success === false) throw new Error(data.error?.message || t('failed'));
      setResult(data.result ?? data);
    });
    const update = () => act('update', async () => {
      const task = await bridge.invoke('host.task.start', { command: 'site', input: { tokens: ['update'] }, executionTimeoutMs: 300000 });
      await bridge.waitTask(task.taskId, { timeoutMs: 310000 });
      await loadCatalog(); await toast(t('loaded'));
    });
    const countText = `${catalog.adapters.length} ${String(locale).startsWith('zh') ? '个适配器' : 'adapters'}`;
    return html`<main class="shell">
      <div class="toolbar"><div class="search-field"><input aria-label=${t('search')} placeholder=${t('search')} value=${query} onInput=${e => setQuery(e.target.value)} /><span class="catalog-count" title=${countText} aria-label=${countText}>${catalog.adapters.length}</span></div><button title=${t('scope')} disabled=${!!busy} aria-busy=${busy === 'update'} onClick=${update}>${spinner('update')}${t(catalog.installed ? 'update' : 'install')}</button></div>
      <div class=${`workspace ${selected ? 'selected' : ''}`}>
        <nav class="list" aria-label=${t('search')}>
          ${[...groups].map(([group, adapters]) => html`<section key=${group}><div class="group">${group} · ${adapters.length}</div>${adapters.map(adapter => html`<button key=${adapter.file} class="adapter" disabled=${busy} aria-pressed=${selected?.file === adapter.file} onClick=${() => choose(adapter)}><strong>${adapter.name}</strong><small class="adapter-description">${adapter.description}</small><small>${t(adapter.source)}</small></button>`)}</section>`)}
          ${!groups.size && html`<div class="empty">${t(busy === 'load' ? 'busy' : catalog.adapters.length ? 'none' : 'empty')}</div>`}
        </nav>
        <section class="detail">
          ${selected ? html`<div class="heading"><button class="back" disabled=${busy} onClick=${() => setSelected(null)}>${t('back')}</button><h2>${selected.name}</h2><span class="badge">${t(selected.source)}</span><span class="badge">${t(selected.readOnly === true ? 'readOnly' : selected.readOnly === false ? 'write' : 'unknown')}</span></div>
            <div class="content"><p>${selected.description}</p><p class="muted">${t('note')}</p>
              <div class="fields">${Object.entries(selected.args).map(([key, definition]) => html`<label key=${key}>${key} · ${t(definition.required ? 'required' : 'optional')}<textarea rows="1" disabled=${busy} required=${!!definition.required} value=${values[key] ?? ''} placeholder=${String(typeof definition === 'string' ? definition : definition.description || key)} onInput=${e => setValues(previous => ({ ...previous, [key]: e.target.value }))} /></label>`)}
                ${!Object.keys(selected.args).length && html`<small>${t('noArgs')}</small>`}
                <label class="target-tab">${t('tab')}<input disabled=${busy} inputMode="numeric" value=${tab} placeholder=${t('auto')} onInput=${e => setTab(e.target.value)} /></label>
              </div>
              <section><h2>${t('command')}</h2><button class="command-copy" title=${t('copy')} aria-label=${t('copy')} aria-busy=${busy === 'command'} disabled=${!!busy} onClick=${() => copyCommand('command')}>${spinner('command')}<code>${command.text}</code></button></section>
              ${result !== null && html`<section><h2>${t('result')}</h2><pre>${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre></section>`}
            </div><div class="actions"><button class="primary" disabled=${!!busy || invalid} aria-busy=${busy === 'execute'} onClick=${execute}>${spinner('execute')}${t('execute')}</button><button disabled=${!!busy} aria-busy=${busy === 'copy'} onClick=${() => copyCommand()}>${spinner('copy')}${t('copy')}</button></div>` : html`<div class="empty">${t('choose')}</div>`}
        </section>
      </div>
    </main>`;
  }
  render(html`<${App} />`, document.getElementById('app'));
})();
