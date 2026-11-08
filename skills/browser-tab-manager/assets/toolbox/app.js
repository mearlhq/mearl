(async () => {
  const context = await window.mearl.ready();
  const messagesFor = locale => String(locale || '').toLowerCase().startsWith('zh') ? {
    title: '标签管理', refresh: '刷新', tabs: '标签页', mearl: 'Mearl 标签',
    group: '智能分组', groupHint: '临时调用一次 Agent，根据标题和网址整理标签页', close: '关闭 Mearl 标签', closeHint: '关闭带 Mearl 图标或当前受控的网页',
    loading: '正在读取标签页…',
    closed: count => `已关闭 ${count} 个 Mearl 标签`, failed: count => `${count} 个标签关闭失败`,
    grouped: count => `已整理 ${count} 个标签页`, noGroups: '没有需要新建的分组',
    groups: '当前分组', unnamedGroup: '未命名分组',
    groupTabs: count => `${count} 个标签页`,
    ungroupLabel: title => `取消「${title}」分组，保留标签页`,
    closeGroupLabel: title => `关闭「${title}」分组及全部标签页`,
    confirmClose: count => `关闭 ${count} 个标签页？`, confirm: '关闭', cancel: '取消',
    ungrouped: count => `已取消分组，保留 ${count} 个标签页`, groupClosed: count => `已关闭 ${count} 个标签页`,
  } : {
    title: 'Tab Manager', refresh: 'Refresh', tabs: 'Tabs', mearl: 'Mearl tabs',
    group: 'Smart group', groupHint: 'Use one temporary Agent task to organize tabs by title and URL', close: 'Close Mearl tabs', closeHint: 'Close web tabs with a Mearl icon or current control marker',
    loading: 'Loading tabs…',
    closed: count => `Closed ${count} Mearl tabs`, failed: count => `${count} tabs could not be closed`,
    grouped: count => `Organized ${count} tabs`, noGroups: 'No new groups were needed',
    groups: 'Current groups', unnamedGroup: 'Untitled group',
    groupTabs: count => `${count} tabs`,
    ungroupLabel: title => `Ungroup ${title} and keep its tabs`,
    closeGroupLabel: title => `Close ${title} and all its tabs`,
    confirmClose: count => `Close ${count} tabs?`, confirm: 'Close', cancel: 'Cancel',
    ungrouped: count => `Ungrouped ${count} tabs`, groupClosed: count => `Closed ${count} tabs`,
  };
  let locale = context.locale;
  let copy = messagesFor(locale);
  function renderLabels(locale) {
    document.documentElement.lang = String(locale).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
    document.title = copy.title;
    for (const [id, value] of Object.entries({ 'tab-count-label': copy.tabs, 'mearl-count-label': copy.mearl, 'group-title': copy.group, 'group-hint': copy.groupHint, 'group-label': copy.group, 'close-title': copy.close, 'close-hint': copy.closeHint, close: copy.close, 'groups-title': copy.groups })) {
      document.getElementById(id).textContent = value;
    }
    const refresh = document.getElementById('refresh');
    refresh.setAttribute('aria-label', copy.refresh);
    refresh.title = copy.refresh;
  }
  renderLabels(context.locale);
  const refreshButton = document.getElementById('refresh');
  const status = document.getElementById('status');
  const closeButton = document.getElementById('close');
  const groupButton = document.getElementById('group');
  const groupsSection = document.getElementById('groups');
  const groupsList = document.getElementById('groups-list');
  let busy = false;
  let mearlCount = 0;
  let groups = [];
  let pendingCloseGroupId = null;

  const icons = {
    ungroup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  };
  const groupColors = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

  function groupActionButton(icon, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `group-button${icon === 'close' ? ' danger' : ''}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = icons[icon];
    button.disabled = busy;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderGroups() {
    groupsList.replaceChildren();
    groupsSection.hidden = groups.length === 0;
    for (const group of groups) {
      const title = group.title || copy.unnamedGroup;
      const row = document.createElement('li');
      row.className = 'group-row';
      if (groupColors.has(group.color)) row.dataset.color = group.color;
      const details = document.createElement('div');
      details.className = 'group-copy';
      const heading = document.createElement('div');
      heading.className = 'group-title';
      const name = document.createElement('strong');
      name.textContent = title;
      name.title = title;
      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = copy.groupTabs(group.tabIds.length);
      heading.append(name);
      details.append(heading, count);
      row.append(details);

      if (pendingCloseGroupId === group.groupId) {
        const confirm = document.createElement('div');
        confirm.className = 'group-confirm';
        const prompt = document.createElement('span');
        prompt.textContent = copy.confirmClose(group.tabIds.length);
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = copy.cancel;
        cancel.addEventListener('click', () => { pendingCloseGroupId = null; renderGroups(); });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'danger';
        close.textContent = copy.confirm;
        close.addEventListener('click', () => void runGroupCommand('close-group', group));
        confirm.append(prompt, cancel, close);
        row.append(confirm);
      } else {
        const buttons = document.createElement('div');
        buttons.className = 'group-buttons';
        buttons.append(
          groupActionButton('ungroup', copy.ungroupLabel(title), () => void runGroupCommand('remove-group', group)),
          groupActionButton('close', copy.closeGroupLabel(title), () => { pendingCloseGroupId = group.groupId; renderGroups(); }),
        );
        row.append(buttons);
      }
      groupsList.append(row);
    }
  }

  function setBusy(value) {
    busy = value;
    groupButton.disabled = value;
    closeButton.disabled = value || mearlCount === 0;
    refreshButton.disabled = value;
    for (const button of groupsList.querySelectorAll('button')) button.disabled = value;
  }

  function setStatus(message, kind = 'info') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  async function waitForOperation(taskId, showProgress = true) {
    return window.mearl.waitTask(taskId, {
      onProgress(progress) {
        const message = typeof progress === 'string' ? progress : progress?.message;
        if (showProgress && message) setStatus(message);
      },
    });
  }

  async function refresh() {
    setStatus(copy.loading);
    try {
      const result = await window.mearl.invoke('summary', {});
      document.getElementById('tab-count').textContent = String(result.count);
      document.getElementById('mearl-count').textContent = String(result.mearlCount);
      mearlCount = result.mearlCount;
      groups = Array.isArray(result.groups) ? result.groups : [];
      pendingCloseGroupId = null;
      renderGroups();
      setBusy(busy);
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function runGroupCommand(command, group) {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      const started = await window.mearl.invoke('host.task.start', { command: command, input: { groupId: group.groupId, windowId: group.windowId, title: group.title, tabIds: group.tabIds } });
      const result = await waitForOperation(started.taskId);
      await window.mearl.invoke('host.toast', { message: command === 'remove-group' ? copy.ungrouped(result.ungroupedTabs) : copy.groupClosed(result.closedCount), type: result.failed?.length ? 'info' : 'success' });
      await refresh();
      if (result.failed?.length) setStatus(`${copy.failed(result.failed.length)}: ${result.failed[0].error}`, 'error');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  refreshButton.addEventListener('click', () => void refresh());
  groupButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    groupButton.classList.add('is-loading');
    groupButton.setAttribute('aria-busy', 'true');
    setStatus('');
    try {
      const started = await window.mearl.invoke('host.task.start', { command: 'smart-group', input: {} });
      const result = await waitForOperation(started.taskId, false);
      await window.mearl.invoke('host.toast', { message: result.groupedTabs ? copy.grouped(result.groupedTabs) : copy.noGroups, type: result.failed.length ? 'error' : 'success' });
      setBusy(false);
      await refresh();
      if (result.failed.length) setStatus(result.failed.map(item => item.error).join('; '), 'error');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      groupButton.classList.remove('is-loading');
      groupButton.removeAttribute('aria-busy');
      setBusy(false);
    }
  });
  closeButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      const started = await window.mearl.invoke('host.task.start', { command: 'close-mearl', input: {} });
      const result = await waitForOperation(started.taskId);
      await window.mearl.invoke('host.toast', { message: copy.closed(result.closedCount), type: result.failed.length ? 'info' : 'success' });
      setBusy(false);
      await refresh();
      if (result.failed.length) setStatus(copy.failed(result.failed.length), 'error');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  });
  window.mearl.onContextChange?.(next => {
    if (next.locale === locale) return;
    locale = next.locale;
    const previous = copy;
    copy = messagesFor(next.locale);
    renderLabels(next.locale);
    if (status.textContent === previous.loading) status.textContent = copy.loading;
    renderGroups();
  });
  await refresh();
})();
