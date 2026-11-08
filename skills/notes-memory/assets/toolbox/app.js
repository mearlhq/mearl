(async () => {
  const bridge = window.mearl, context = await bridge.ready();
  const { h, html, render, useState, useEffect, useRef } = bridge.ui;
  const messages = {
    zh_CN: {
      search: '搜索笔记', closeSearch: '关闭搜索', add: '新建笔记', placeholder: '记点什么…', empty: '还没有笔记，直接开始写吧', noResults: '没有匹配的笔记',
      saved: '已保存', saving: '保存中…', unsaved: '尚未保存', newNote: '随手记', recent: '笔记', trashTitle: '回收站', emptyTrash: '回收站是空的',
      agent: '最近由 Agent 编辑', copy: '复制正文', copied: '已复制',
      capture: '收录页面', addImage: '添加图片（也可粘贴或拖入）', pickPage: '选择要收录的网页', noPages: '没有可收录的网页', close: '关闭', image: '预览图片', removeImage: '移除图片',
      invalidImage: '支持 PNG、JPEG、WebP，每张最多 5 MiB，每篇最多 12 张', imageFailed: '图片读取失败，点击重试', importing: '正在添加…', remove: '移到回收站', restore: '恢复笔记',
      purge: '彻底删除', clearTrash: '清空回收站', noteLists: '笔记列表',
      deleted: '已移到回收站', moreNotes: '加载更多', failed: '操作失败', retry: '重试保存', reload: '重新读取（替换草稿）',
      conflict: '笔记已在别处修改，草稿已保留。请先复制草稿，再重新读取。',
    },
    en: {
      search: 'Search notes', closeSearch: 'Close search', add: 'New note', placeholder: 'Write something…', empty: 'No notes yet. Start writing.', noResults: 'No matching notes',
      saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved', newNote: 'Quick note', recent: 'Notes', trashTitle: 'Trash', emptyTrash: 'Trash is empty',
      agent: 'Last edited by Agent', copy: 'Copy text', copied: 'Copied',
      capture: 'Capture page', addImage: 'Add images (or paste or drop)', pickPage: 'Choose a page to capture', noPages: 'No web pages available', close: 'Close', image: 'Preview image', removeImage: 'Remove image',
      invalidImage: 'PNG, JPEG or WebP, up to 5 MiB each and 12 images per note', imageFailed: 'Image unavailable. Click to retry.', importing: 'Adding…', remove: 'Move to trash', restore: 'Restore note',
      purge: 'Delete permanently', clearTrash: 'Empty trash', noteLists: 'Note lists',
      deleted: 'In trash', moreNotes: 'Load more', failed: 'Something went wrong', retry: 'Retry save', reload: 'Reload (replace draft)',
      conflict: 'This note changed elsewhere. Your draft is preserved. Copy it before reloading.',
    },
  };
  let locale = context.locale;
  const t = key => messages[String(locale).startsWith('zh') ? 'zh_CN' : 'en'][key];
  const icon = (name, size = 'icon') => html`<svg class=${`${size}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${window.notesIcons[name].map(([tag, attrs]) => h(tag, attrs))}</svg>`;
  const iconButton = 'icon-button';
  const menuButton = 'load-more';
  const blank = () => ({ id: null, revision: 0, title: '', body: '', tags: [], scope: 'personal', project: null, pinned: false, source: '', images: [], updatedBy: 'user', deletedAt: null });
  const excerpt = item => {
    const lines = (item.excerpt || '').trim().split('\n');
    const first = lines[0].replace(/^#+\s*/, '').trim();
    if (first === item.title.trim() || first.slice(0, 80) === item.title.trim()) lines.shift();
    return lines.join(' ').replace(/\s+/g, ' ').trim();
  };
  function Attachment({ id, image, disabled, readOnly, onRemove, onPreview }) {
    const [url, setUrl] = useState(''), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
    useEffect(() => {
      let active = true, objectUrl;
      setFailed(false);
      window.notesImages.read(bridge, id, image.id).then(blob => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
      }).catch(() => { if (active) setFailed(true); });
      return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [id, image.id, attempt]);
    return html`<div class="attachment">
      <button class="attachment-preview" aria-label=${`${t('image')}：${image.name}`} title=${failed ? t('imageFailed') : image.name} onClick=${() => failed ? setAttempt(value => value + 1) : url && onPreview({ url, name: image.name })}>
        ${url && !failed ? html`<img class="attachment-image" src=${url} alt=${image.name} onError=${() => setFailed(true)} />` : icon('image', 'icon-large')}
      </button>
      ${!readOnly ? html`<button class="attachment-remove" aria-label=${`${t('removeImage')}：${image.name}`} title=${t('removeImage')} disabled=${disabled} onClick=${() => onRemove(image)}>${icon('close')}</button>` : null}
    </div>`;
  }
  function App() {
    const [, setLocale] = useState(locale), [notes, setNotes] = useState([]), [query, setQuery] = useState(''), [searchOpen, setSearchOpen] = useState(false), [trash, setTrash] = useState(false);
    const [state, setState] = useState(null), [offset, setOffset] = useState(null), [loading, setLoading] = useState(false), [listLoaded, setListLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [pages, setPages] = useState(null), [preview, setPreview] = useState(null), [dragging, setDragging] = useState(false), [importing, setImporting] = useState(false);
    const linkOverlay = useRef(null), linkDecoration = useRef(null);
    const editor = useRef(null), textarea = useRef(null), searchInput = useRef(null), fileInput = useRef(null), dialog = useRef(null), timer = useRef(null), sequence = useRef(0), selection = useRef(0), mounted = useRef(true), locked = useRef(false), activeNote = useRef(null), view = useRef({ trash, query });
    view.current = { trash, query };
    const note = state?.note, conflict = String(state?.error?.message).includes('NOTE_CONFLICT');
    const report = failure => { if (mounted.current) setError(failure.message || t('failed')); };
    const install = (note, focus = true) => {
      setPreview(null);
      const readKey = ++selection.current;
      editor.current = window.notesEditor(note, async snapshot => {
        if (!snapshot.id && !snapshot.body.trim() && !snapshot.title) return { note: snapshot };
        const title = snapshot.body.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || snapshot.title || t('newNote');
        return bridge.invoke(snapshot.id ? 'update' : 'create', {
          ...(snapshot.id ? { id: snapshot.id, revision: snapshot.revision } : {}),
          title, body: snapshot.body, tags: snapshot.tags, scope: snapshot.scope, project: snapshot.project,
          pinned: snapshot.pinned, source: snapshot.source, updatedBy: 'user',
        });
      }, next => {
        if (!mounted.current || readKey !== selection.current) return;
        setState({ ...next, note: { ...next.note }, readKey });
        if (!next.dirty && next.note.id) setNotes(items => {
          const item = { ...next.note, excerpt: next.note.body.slice(0, 280) };
          const terms = view.current.query.toLocaleLowerCase().split(/\s+/).filter(Boolean), haystack = `${item.title}\n${item.body}\n${item.tags.join(' ')}`.toLocaleLowerCase();
          if (Boolean(item.deletedAt) !== view.current.trash || !terms.every(term => haystack.includes(term))) return items.filter(existing => existing.id !== item.id);
          return items.some(existing => existing.id === item.id) ? items.map(existing => existing.id === item.id ? item : existing) : [item, ...items];
        });
      });
      setState({ ...editor.current.state(), readKey, focus }); setError('');
    };
    const load = async (append = false, start = 0) => {
      const request = ++sequence.current; setLoading(true);
      try {
        const result = await bridge.invoke('page-list', { ...view.current, offset: start });
        if (mounted.current && request === sequence.current) { setNotes(items => append ? [...items, ...result.notes] : result.notes); setOffset(result.nextOffset); setListLoaded(true); }
      } catch (failure) { if (request === sequence.current) report(failure); }
      finally { if (mounted.current && request === sequence.current) setLoading(false); }
    };
    const flush = async () => { clearTimeout(timer.current); return !editor.current || await editor.current.save(); };
    const openLink = event => {
      if (busy || event.button !== 0 || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const url = window.notesLinks.atPoint(event.currentTarget, event.clientX, event.clientY);
      if (!url) return;
      event.preventDefault();
      void act(async () => { if (await flush()) await bridge.invoke('host.link.open', { url }); });
    };
    const act = async operation => {
      if (locked.current) return;
      locked.current = true; setBusy(true); setError('');
      try { await operation(); } catch (failure) { report(failure); }
      finally { locked.current = false; if (mounted.current) setBusy(false); }
    };
    const choose = id => act(async () => {
      if (!await flush()) return;
      const selected = (await bridge.invoke('get', { id })).note;
      if (selected.deletedAt && !editor.current.state().note.deletedAt) activeNote.current = { ...editor.current.state().note };
      install(selected);
    });
    const create = () => act(async () => { if (await flush()) { setTrash(false); setQuery(''); install(blank()); } });
    const edit = body => {
      editor.current.edit({ body }); clearTimeout(timer.current);
      timer.current = setTimeout(() => void editor.current?.save(), 350);
    };
    const switchList = next => {
      if (next === trash || locked.current) return;
      view.current = { trash: next, query: next ? '' : query };
      if (next) { setQuery(''); setSearchOpen(false); }
      sequence.current++; setNotes([]); setOffset(null); setListLoaded(false); setLoading(true); setTrash(next);
      if (!next && editor.current.state().note.deletedAt) install(activeNote.current || blank(), false);
    };
    const removeOrRestore = item => act(async () => {
      let target = item;
      if (editor.current.state().note.id === item.id) {
        if (!await flush()) return;
        target = editor.current.state().note;
      }
      const result = await bridge.invoke(target.deletedAt ? 'restore' : 'delete', { id: target.id, revision: target.revision, updatedBy: 'user' });
      if (editor.current.state().note.id === target.id) install(target.deletedAt ? (activeNote.current || blank()) : blank(), false);
      if (activeNote.current?.id === target.id) activeNote.current = result.note.deletedAt ? null : result.note;
      await load();
    });
    const purge = item => act(async () => {
      await bridge.invoke('purge', { id: item.id, revision: item.revision });
      if (editor.current.state().note.id === item.id) install(activeNote.current || blank(), false);
      await load();
    });
    const clearTrash = () => act(async () => {
      await bridge.invoke('empty-trash', {});
      if (editor.current.state().note.deletedAt) install(activeNote.current || blank(), false);
      await load();
    });
    const reload = () => act(async () => {
      clearTimeout(timer.current); install((await bridge.invoke('get', { id: note.id })).note); await load();
    });
    const copy = () => act(async () => { await bridge.invoke('host.clipboard.writeText', { text: editor.current.state().note.body }); await bridge.invoke('host.toast', { message: t('copied'), type: 'success' }); });
    const collectPage = async page => {
      if (!await flush()) return;
      const current = editor.current.state().note;
      const text = `${page.title || page.url}\n${page.url}`;
      editor.current.edit({ body: current.body.trimEnd() + (current.body.trim() ? '\n\n' : '') + text, source: current.source || page.url.slice(0, 500) });
      setPages(null); await editor.current.save();
    };
    const capture = () => act(async () => {
      const active = await bridge.invoke('host.tab.active', {});
      if (active) await collectPage(active);
      else setPages((await bridge.invoke('tabs', {})).tabs);
    });
    const addImages = files => act(async () => {
      if (!files.length || editor.current.state().note.deletedAt) return;
      if (files.length + (editor.current.state().note.images?.length || 0) > 12 || files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size < 12 || file.size > 5 * 1024 * 1024)) throw new Error(t('invalidImage'));
      setImporting(true);
      try {
        const current = editor.current.state().note;
        if (!current.id && !current.body.trim()) editor.current.edit({ title: files[0].name.slice(0, 200) });
        if (!await flush()) return;
        for (const file of files) install(await window.notesImages.upload(bridge, editor.current.state().note, file), false);
      } finally { if (mounted.current) setImporting(false); }
      textarea.current?.focus();
    });
    const removeImage = image => act(async () => {
      if (!await flush()) return;
      const current = editor.current.state().note;
      install((await bridge.invoke('image-remove', { id: current.id, revision: current.revision, imageId: image.id })).note, false);
    });
    useEffect(() => {
      const paste = event => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.length) { event.preventDefault(); void addImages(files); }
      };
      document.addEventListener('paste', paste); return () => document.removeEventListener('paste', paste);
    }, []);
    useEffect(() => {
      const decoration = window.notesLinks.decorate(textarea.current, linkOverlay.current);
      linkDecoration.current = decoration;
      return () => { decoration.dispose(); linkDecoration.current = null; };
    }, []);
    useEffect(() => { linkDecoration.current?.refresh(); }, [note?.body, state?.readKey]);
    useEffect(() => { if (preview && !dialog.current?.open) dialog.current?.showModal(); }, [Boolean(preview)]);
    useEffect(() => { mounted.current = true; install(blank()); return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);
    useEffect(() => { const timeout = setTimeout(() => void load(), query ? 150 : 0); return () => { clearTimeout(timeout); sequence.current++; }; }, [query, trash]);
    useEffect(() => { if (state?.focus && !note?.deletedAt) textarea.current?.focus(); }, [state?.readKey]);
    useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
    useEffect(() => bridge.onContextChange(next => {
      locale = next.locale; setLocale(locale);
      document.documentElement.lang = String(locale).startsWith('zh') ? 'zh-CN' : 'en';
    }), []);
    useEffect(() => {
      const keydown = event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void flush(); }
      };
      const beforeUnload = event => { if (editor.current?.state().dirty) { void flush(); event.preventDefault(); event.returnValue = ''; } };
      window.addEventListener('keydown', keydown); window.addEventListener('beforeunload', beforeUnload);
      return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('beforeunload', beforeUnload); };
    }, []);
    return html`<main class="notes-app" aria-busy=${busy}
      onDragOver=${event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragLeave=${event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop=${event => { if (event.dataTransfer?.files?.length) { event.preventDefault(); setDragging(false); void addImages([...event.dataTransfer.files]); } }}>
      <input ref=${fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" aria-label=${t('addImage')} onChange=${event => { void addImages([...event.target.files]); event.target.value = ''; }} />
      <section class=${`editor-card ${dragging ? 'is-dragging' : ''}`}>
        <div class="editor-toolbar">
          <span role="status" class="truncate">${importing ? t('importing') : note?.deletedAt ? t('deleted') : state?.error ? t('unsaved') : state?.saving ? t('saving') : state?.dirty ? t('unsaved') : note?.id ? t('saved') : t('newNote')}</span>
          <div class="actions-end">
            <button class=${iconButton} title=${t('add')} aria-label=${t('add')} disabled=${busy} onClick=${create}>${icon('plus')}</button>
            <button class=${`${iconButton} ${note?.deletedAt ? 'is-unavailable' : ''}`} title=${t('capture')} aria-label=${t('capture')} disabled=${busy || Boolean(note?.deletedAt)} onClick=${capture}>${icon('capture')}</button>
            <button class=${`${iconButton} ${note?.deletedAt ? 'is-unavailable' : ''}`} title=${t('addImage')} aria-label=${t('addImage')} disabled=${busy || Boolean(note?.deletedAt)} onClick=${() => fileInput.current.click()}>${icon('image')}</button>
          </div>
        </div>
        ${pages !== null ? html`<div class="page-picker">
          <div class="picker-heading"><span>${t('pickPage')}</span><button class=${iconButton} aria-label=${t('close')} onClick=${() => setPages(null)}>${icon('close')}</button></div>
          <div class="picker-scroll">${pages.length ? pages.map(page => html`<button key=${page.id} class="page-option" disabled=${busy} onClick=${() => act(() => collectPage(page))}><span class="page-title">${page.title || page.url}</span><span class="page-url">${page.url}</span></button>`) : html`<p class="empty-picker">${t('noPages')}</p>`}</div>
        </div>` : null}
        ${error || state?.error ? html`<div role="alert" class="save-error"><p>${error || (conflict ? t('conflict') : state.error.message)}</p>${state?.error ? html`<div class="error-actions"><button class="text-button" onClick=${copy}>${t('copy')}</button>${note?.id ? html`<button class="text-button" onClick=${reload}>${t('reload')}</button>` : null}${!conflict ? html`<button class="text-button" onClick=${() => editor.current.retry()}>${t('retry')}</button>` : null}</div>` : null}</div>` : null}
        <div class="note-input">
          <textarea ref=${textarea} aria-label=${t('placeholder')} class="note-body" placeholder=${t('placeholder')} value=${note?.body || ''} readOnly=${busy || Boolean(note?.deletedAt)} onInput=${event => { if (!busy && !note?.deletedAt) edit(event.currentTarget.value); }} onClick=${openLink} onBlur=${() => void flush()}></textarea>
          <div ref=${linkOverlay} class="note-link-overlay" aria-hidden="true"></div>
        </div>
        ${note?.images?.length ? html`<div class="attachments">${note.images.map(image => html`<${Attachment} key=${image.id} id=${note.id} image=${image} disabled=${busy} readOnly=${Boolean(note.deletedAt)} onRemove=${removeImage} onPreview=${setPreview} />`)}</div>` : null}
      </section>
      <aside class="notes-list">
        <div class="list-toolbar">
          <div role="group" aria-label=${t('noteLists')} class="actions">
            <button class=${`list-tab ${!trash ? 'is-active' : ''}`} aria-pressed=${!trash} disabled=${busy} onClick=${() => switchList(false)}>${t('recent')}</button>
            <button class=${`list-tab ${trash ? 'is-active' : ''}`} aria-pressed=${trash} disabled=${busy} onClick=${() => switchList(true)}>${t('trashTitle')}</button>
          </div>
          <div class="search-actions">${trash ? html`<button class=${`${iconButton} danger ${!notes.length ? 'is-unavailable' : ''}`} title=${t('clearTrash')} aria-label=${t('clearTrash')} disabled=${busy || loading || !notes.length} onClick=${clearTrash}>${icon('clear')}</button>` : searchOpen ? html`<input ref=${searchInput} type="search" class="search-input" aria-label=${t('search')} value=${query} onInput=${event => setQuery(event.currentTarget.value)} onKeyDown=${event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }} onBlur=${() => { if (!query) setSearchOpen(false); }} /><button class=${iconButton} title=${t('closeSearch')} aria-label=${t('closeSearch')} onClick=${() => { setQuery(''); setSearchOpen(false); }}>${icon('close')}</button>` : html`<button class=${iconButton} title=${t('search')} aria-label=${t('search')} onClick=${() => setSearchOpen(true)}>${icon('search')}</button>`}</div>
        </div>
        <div class="list-scroll"><div class="note-rows">${notes.map(item => { const preview = excerpt(item); return html`<div key=${item.id} class=${`note-row ${note?.id === item.id ? 'is-active' : ''}`}>
          <button class="note-open" title=${item.title} disabled=${busy} onClick=${() => choose(item.id)}><span class=${`note-heading ${preview ? 'with-preview' : ''}`}><span class="note-title">${item.title}</span>${item.updatedBy === 'agent' ? html`<span class="agent-mark" title=${t('agent')} aria-label=${t('agent')}>${icon('bot')}</span>` : null}</span>${preview ? html`<span class="note-excerpt">${preview}</span>` : null}</button>
            <button class=${iconButton} title=${item.deletedAt ? t('restore') : t('remove')} aria-label=${`${item.deletedAt ? t('restore') : t('remove')}：${item.title}`} disabled=${busy} onClick=${() => removeOrRestore(item)}>${icon(item.deletedAt ? 'restore' : 'trash')}</button>
            ${item.deletedAt ? html`<button class=${`${iconButton} danger`} title=${t('purge')} aria-label=${`${t('purge')}：${item.title}`} disabled=${busy} onClick=${() => purge(item)}>${icon('remove')}</button>` : null}
        </div>`; })}</div>${!notes.length && listLoaded ? html`<p class="empty-list">${query ? t('noResults') : trash ? t('emptyTrash') : t('empty')}</p>` : null}${offset !== null ? html`<button class=${menuButton} disabled=${loading} onClick=${() => load(true, offset)}>${t('moreNotes')}</button>` : null}</div>
      </aside>
      ${preview ? html`<dialog ref=${dialog} aria-label=${t('image')} class="image-dialog" onCancel=${() => setPreview(null)} onClose=${() => setPreview(null)}>
        <div class="preview-toolbar"><span class="preview-title">${preview.name}</span><button class=${iconButton} aria-label=${t('close')} onClick=${() => setPreview(null)}>${icon('close')}</button></div>
        <div class="preview-scroll"><img class="preview-image" src=${preview.url} alt=${preview.name} /></div>
      </dialog>` : null}
    </main>`;
  }
  render(html`<${App} />`, document.getElementById('app'));
})().catch(error => { document.getElementById('app').textContent = error.message; });
