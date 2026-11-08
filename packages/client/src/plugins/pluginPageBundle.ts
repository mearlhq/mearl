import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pluginFileVersion } from './pluginSource.js';

export const PLUGIN_PAGE_CHUNK_BYTES = 384 * 1024;
const MAX_PAGE_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PAGE_BUNDLE_BYTES = 24 * 1024 * 1024;

export interface BuiltPluginPageBundle {
  content: string;
  hash: string;
  size: number;
  chunks: number;
  sources: Record<string, string>;
}

const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const PAGE_BRIDGE_SCRIPT = String.raw`(() => {
  let context = null;
  let port = null;
  let requestSequence = 0;
  const pending = new Map();
  const contextListeners = new Set();
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  let pageModalOpen = null;
  let modalRestoreFrame = null;
  const syncPageModal = () => {
    if (!port) return;
    const open = Boolean(document.querySelector?.('dialog:modal'));
    if (open && modalRestoreFrame !== null) {
      cancelAnimationFrame(modalRestoreFrame);
      modalRestoreFrame = null;
    }
    if (open === pageModalOpen) return;
    if (!open && pageModalOpen === true) {
      if (modalRestoreFrame !== null) return;
      // Closing a dialog restores focus and can scroll the anchors before the next paint.
      modalRestoreFrame = requestAnimationFrame(() => {
        modalRestoreFrame = null;
        if (document.querySelector?.('dialog:modal')) return;
        const positions = [];
        for (const { presentation } of anchoredAgentPanels.values()) {
          if (!presentation.element.isConnected) continue;
          const rect = presentation.element.getBoundingClientRect();
          if (![rect.top, rect.left, rect.width, rect.height].every(Number.isFinite)) continue;
          const bounds = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          presentation.bounds = bounds;
          positions.push({ key: presentation.key, bounds });
        }
        pageModalOpen = false;
        port.postMessage({ type: 'page-modal', open: false, positions });
      });
      return;
    }
    pageModalOpen = open;
    port.postMessage({ type: 'page-modal', open });
  };

  const requestHost = async (type, payload = {}) => {
    await ready;
    const requestId = String(++requestSequence);
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      port.postMessage({ type, requestId, ...payload });
    });
  };

  const invoke = async (command, input = {}) => {
    if (typeof command !== 'string' || (!/^[a-z][a-z0-9-]*$/.test(command) && !/^host\.[a-z][a-zA-Z]*(?:\.[a-z][a-zA-Z]*)*$/.test(command))) throw new Error('Invalid command');
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Plugin command input must be an object');
    }
    return requestHost('invoke', { command, input });
  };

  const subscribe = async (source, target, listener) => {
    if (source !== 'page' || !target || typeof target.instanceId !== 'string' ||
        !/^pi_[0-9a-f-]{36}$/i.test(target.instanceId) || typeof listener !== 'function') throw new Error('Invalid page event subscription');
    let stopped = false, timer, cursor = target.cursor ?? 0;
    const poll = async (waitMs = 0) => {
      let delay = 0;
      try {
        const page = await invoke('host.page.events', { instanceId: target.instanceId, cursor, waitMs });
        if (stopped) return;
        const metadata = { url: page.instance.target.url, instance: page.instance, gap: page.gap };
        if (page.gap) listener({ type: 'resync' }, metadata);
        for (const event of page.events) { if (stopped) return; listener(event, metadata); }
        cursor = page.nextCursor;
        if (page.instance.state !== 'active') return;
      } catch (error) { if (stopped) return; delay = 500; listener({ type: 'connection-error', error: { message: error.message } }); }
      if (!stopped) timer = setTimeout(() => { void poll(25000); }, delay);
    };
    await poll();
    return () => { stopped = true; clearTimeout(timer); };
  };

  const handleExternalLinkClick = event => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.target?.closest?.('a[href]');
    if (!link || String(link.target).toLowerCase() !== '_blank' || link.hasAttribute?.('download')) {
      return;
    }
    let url;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    event.preventDefault();
    void invoke('host.link.open', { url: url.href }).catch(error => {
      console.error('Failed to open external link', error);
    });
  };

  const agentPanelLayout = options => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Agent panel options must be an object');
    }
    const layout = options.layout;
    if (layout !== undefined && layout !== 'drawer' && layout !== 'workspace' && layout !== 'inline') {
      throw new Error('Agent panel layout must be drawer, workspace, or inline');
    }
    return layout;
  };

  const agentPanelKey = (options, required = false) => {
    const key = typeof options.key === 'string' ? options.key.trim() : '';
    if ((required || options.key !== undefined) && (!key || key.length > 128)) {
      throw new Error('Agent panel key must be a non-empty string no longer than 128 characters');
    }
    return key || null;
  };

  const agentPanelCwd = options => {
    const cwd = options.cwd;
    if (
      cwd !== undefined &&
      (typeof cwd !== 'string' ||
        !cwd.trim() ||
        cwd.length > 4096 ||
        !/^(?:\/|[a-zA-Z]:[\\/])/.test(cwd.trim()))
    ) {
      throw new Error('Agent panel cwd must be an absolute path no longer than 4096 characters');
    }
    return cwd === undefined ? null : cwd.trim();
  };

  const agentPanelContext = options => {
    const context = options.context;
    if (
      context !== undefined &&
      (typeof context !== 'string' || !context.trim() || context.length > 65536)
    ) {
      throw new Error('Agent panel context must be a non-empty string no longer than 65536 characters');
    }
    return context === undefined ? null : context.trim();
  };

  const anchoredAgentPanels = new Map();

  const stopAgentAnchorTracking = key => {
    if (key) {
      anchoredAgentPanels.get(key)?.cleanup();
      anchoredAgentPanels.delete(key);
      return;
    }
    for (const tracked of anchoredAgentPanels.values()) tracked.cleanup();
    anchoredAgentPanels.clear();
  };

  const agentPanelAnchor = (options, key, layout) => {
    const anchor = options.anchor;
    if (!(anchor instanceof Element)) {
      throw new Error('Agent panel anchor must be an element');
    }
    const rect = anchor.getBoundingClientRect();
    if (![rect.top, rect.left, rect.width, rect.height].every(Number.isFinite)) {
      throw new Error('Agent panel anchor returned invalid bounds');
    }
    return {
      element: anchor,
      key,
      layout,
      bounds: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    };
  };

  const trackAgentAnchor = presentation => {
    if (presentation.layout === 'workspace' || [...anchoredAgentPanels.values()].some(item => item.presentation.layout === 'workspace')) {
      stopAgentAnchorTracking();
    } else {
      stopAgentAnchorTracking(presentation.key);
    }
    let frame = null;
    const update = () => {
      frame = null;
      if (!presentation.element.isConnected || !port) return;
      const rect = presentation.element.getBoundingClientRect();
      if (![rect.top, rect.left, rect.width, rect.height].every(Number.isFinite)) return;
      const bounds = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      if (
        bounds.top === presentation.bounds.top &&
        bounds.left === presentation.bounds.left &&
        bounds.width === presentation.bounds.width &&
        bounds.height === presentation.bounds.height
      ) return;
      presentation.bounds = bounds;
      port.postMessage({
        type: 'agent-panel-position',
        key: presentation.key,
        bounds,
      });
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(update);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(presentation.element);
    observer?.observe(document.documentElement);
    const mutationObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(schedule)
      : null;
    mutationObserver?.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    const cleanup = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
    };
    anchoredAgentPanels.set(presentation.key, { presentation, cleanup });
  };

  const scrollInlineAgentPage = (presentation, deltaX, deltaY) => {
    const scrollAxis = (axis, delta) => {
      if (!delta) return;
      let element = presentation.element;
      while (element) {
        const style = window.getComputedStyle(element);
        const overflow = axis === 'x' ? style.overflowX : style.overflowY;
        const scrollSize = axis === 'x' ? element.scrollWidth : element.scrollHeight;
        const clientSize = axis === 'x' ? element.clientWidth : element.clientHeight;
        if (/^(auto|scroll|overlay)$/.test(overflow) && scrollSize > clientSize) {
          const scrollPosition = axis === 'x' ? element.scrollLeft : element.scrollTop;
          const maximum = scrollSize - clientSize;
          if ((delta < 0 && scrollPosition > 0) || (delta > 0 && scrollPosition < maximum - 1)) {
            if (axis === 'x') element.scrollLeft += delta;
            else element.scrollTop += delta;
            return;
          }
        }
        element = element.parentElement;
      }
      window.scrollBy(axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
    };
    scrollAxis('x', deltaX);
    scrollAxis('y', deltaY);
  };

  const agentPanelPresentation = (options, layout, key) => {
    if (layout === 'inline') return agentPanelAnchor(options, key, layout);
    if (layout === 'workspace' && options.anchor !== undefined) {
      return agentPanelAnchor(options, key || 'toolbox-workspace', layout);
    }
    return null;
  };

  const setAgentPanelVisible = async (visible, options = {}) => {
    if (typeof visible !== 'boolean') throw new Error('Agent panel visibility must be a boolean');
    const layout = agentPanelLayout(options);
    const key = agentPanelKey(options, visible && layout === 'inline');
    const cwd = visible ? agentPanelCwd(options) : null;
    const context = visible ? agentPanelContext(options) : null;
    const presentation = visible ? agentPanelPresentation(options, layout, key) : null;
    const request = requestHost('agent-panel', {
      visible,
      ...(layout ? { layout } : {}),
      ...(key ? { key } : {}),
      ...(cwd ? { cwd } : {}),
      ...(context ? { context } : {}),
      ...(presentation ? { bounds: presentation.bounds } : {}),
    });
    if (presentation) {
      await ready;
      trackAgentAnchor(presentation);
    } else if (!visible && key) {
      stopAgentAnchorTracking(key);
    } else {
      stopAgentAnchorTracking();
    }
    try {
      await request;
    } catch (error) {
      if (presentation) stopAgentAnchorTracking(presentation.key);
      throw error;
    }
  };

  const agentGuideText = (value, label, maximumLength) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || normalized.length > maximumLength) {
      throw new Error(label + ' must be a non-empty string no longer than ' + maximumLength + ' characters');
    }
    return normalized;
  };

  const setAgentGuides = async guides => {
    if (!Array.isArray(guides) || guides.length === 0 || guides.length > 6) {
      throw new Error('Agent guides must contain between 1 and 6 items');
    }
    const normalized = guides.map((guide, index) => {
      if (!guide || typeof guide !== 'object' || Array.isArray(guide)) {
        throw new Error('Agent guide ' + index + ' must be an object');
      }
      const icon = guide.icon === undefined ? undefined : agentGuideText(guide.icon, 'Agent guide icon', 40);
      if (icon && !/^[a-z][a-z0-9-]*$/.test(icon)) {
        throw new Error('Agent guide icon must use kebab-case');
      }
      return {
        title: agentGuideText(guide.title, 'Agent guide title', 80),
        description: agentGuideText(guide.description, 'Agent guide description', 160),
        prompt: agentGuideText(guide.prompt, 'Agent guide prompt', 4000),
        ...(icon ? { icon } : {}),
      };
    });
    await requestHost('agent-guides', { guides: normalized });
  };

  const runAgentTask = async (prompt, options = {}) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) {
      throw new Error('Agent task prompt must be a non-empty string no longer than 16000 characters');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Agent task options must be an object');
    }
    const cwd = options.cwd;
    const ephemeral = options.ephemeral;
    const layout = agentPanelLayout(options);
    const key = agentPanelKey(options, layout === 'inline');
    const presentation = agentPanelPresentation(options, layout, key);
    if (ephemeral !== undefined && ephemeral !== false) {
      throw new Error('Temporary Agent conversations are not supported');
    }
    if (
      cwd !== undefined &&
      (typeof cwd !== 'string' ||
        !cwd.trim() ||
        cwd.length > 4096 ||
        !/^(?:\/|[a-zA-Z]:[\\/])/.test(cwd.trim()))
    ) {
      throw new Error('Agent task cwd must be an absolute path no longer than 4096 characters');
    }
    const request = requestHost('agent-task', {
      prompt: prompt.trim(),
      ...(cwd !== undefined ? { cwd: cwd.trim() } : {}),
      ...(layout ? { layout } : {}),
      ...(key ? { key } : {}),
      ...(presentation ? { bounds: presentation.bounds } : {}),
    });
    if (presentation) {
      await ready;
      trackAgentAnchor(presentation);
    } else {
      stopAgentAnchorTracking();
    }
    try {
      await request;
    } catch (error) {
      if (presentation) stopAgentAnchorTracking(presentation.key);
      throw error;
    }
  };

  const setQueryParam = async (name, value) => {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
      throw new Error('Query parameter name is invalid');
    }
    if (value !== null && (typeof value !== 'string' || value.length > 512)) {
      throw new Error('Query parameter value must be null or a string no longer than 512 characters');
    }
    const query = await requestHost('query-param', { name, value });
    applyContext({ query });
    return query;
  };

  const onContextChange = listener => {
    if (typeof listener !== 'function') throw new Error('Invalid context listener');
    contextListeners.add(listener);
    if (context) listener(context);
    return () => contextListeners.delete(listener);
  };
  const readTaskResult = async taskId => {
    const task = await invoke('host.task.get', { taskId });
    const reference = task.result;
    if (task.state !== 'success' || !reference || !Number.isSafeInteger(reference.bytes) ||
        reference.bytes < 1 || reference.bytes > 64 * 1024 * 1024 ||
        !Number.isSafeInteger(reference.chunks) || reference.chunks < 1 || reference.chunks > 1024 ||
        !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error('Invalid task result reference');
    const data = new Uint8Array(reference.bytes);
    let offset = 0;
    for (let index = 0; index < reference.chunks; index++) {
      const chunk = await invoke('host.task.result', { taskId, index });
      if (chunk.taskId !== taskId || chunk.index !== index || chunk.sha256 !== reference.sha256 ||
          chunk.bytes !== reference.bytes || chunk.chunks !== reference.chunks) throw new Error('Task result chunk identity mismatch');
      const binary = atob(chunk.data);
      if (offset + binary.length > data.length) throw new Error('Task result size mismatch');
      for (let i = 0; i < binary.length; i++) data[offset++] = binary.charCodeAt(i);
    }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
      value => value.toString(16).padStart(2, '0')).join('');
    if (offset !== reference.bytes || hash !== reference.sha256) throw new Error('Task result integrity check failed');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)).value;
  };
  const waitTask = async (taskId, options = {}) => {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new Error('Invalid task wait timeout');
    const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
    let cursor = 0, lastSequence = -1;
    for (;;) {
      options.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Object.assign(new Error('Waiting for the task timed out; execution continues'), { code: 'PLUGIN_TASK_WAIT_TIMEOUT' });
      let page;
      try {
        page = await invoke('host.task.events', { taskId, cursor, waitMs: Math.min(1000, remaining) });
        options.onConnectionChange?.(false);
      } catch (error) { options.onConnectionChange?.(true); throw error; }
      options.signal?.throwIfAborted();
      const task = page.task;
      cursor = page.nextCursor;
      if (task.progress && task.sequence !== lastSequence) options.onProgress?.(task.progress, task);
      lastSequence = task.sequence;
      if (task.state === 'success') return readTaskResult(taskId);
      if (!['queued', 'running', 'cancelling'].includes(task.state))
        throw Object.assign(new Error(task.error?.message || 'Plugin task ended with ' + task.state), { code: task.error?.code });
    }
  };
  const listTasks = async (options = {}) => {
    const tasks = [];
    let cursor;
    do {
      const page = await invoke('host.task.list', { activeOnly: options.activeOnly !== false, ...(cursor ? { cursor } : {}) });
      tasks.push(...page.tasks);
      cursor = page.nextCursor;
    } while (cursor);
    return { tasks };
  };
  const api = { invoke, subscribe, readTaskResult, waitTask, listTasks, onContextChange, ready: async () => { await ready; return context; }, runAgentTask, setAgentGuides, setAgentPanelVisible, setQueryParam };
  const ui = globalThis.__mearlToolboxUi;
  if (ui !== undefined) {
    if (!ui || typeof ui !== 'object' || ui.runtime !== 'preact') {
      throw new Error('Invalid Mearl toolbox UI runtime');
    }
    Object.defineProperty(api, 'ui', { enumerable: true, value: ui });
    delete globalThis.__mearlToolboxUi;
  }
  Object.defineProperty(api, 'context', { enumerable: true, get: () => context });
  Object.defineProperty(window, 'mearl', { configurable: false, value: Object.freeze(api) });
  document.addEventListener('click', handleExternalLinkClick);

  const applyContext = nextContext => {
    const theme =
      nextContext?.theme === 'dark' ||
      (nextContext?.theme !== 'light' && context?.theme === 'dark')
        ? 'dark'
        : 'light';
    const fontSize = String(nextContext?.fontSize || context?.fontSize || '');
    document.documentElement.dataset.mearlTheme = theme;
    document.documentElement.style.colorScheme = theme;
    if (/^\d+(?:\.\d+)?px$/.test(fontSize)) document.documentElement.style.fontSize = fontSize;
    context = Object.freeze({ ...(context || {}), ...(nextContext || {}), theme });
    for (const listener of contextListeners) {
      try { listener(context); }
      catch (error) { console.error('Toolbox context listener failed', error); }
    }
    return context;
  };

  const connect = event => {
    const message = event.data;
    const nextPort = event.ports && event.ports[0];
    if (
      (event.source && event.source !== window.parent) ||
      message?.type !== 'mearl-plugin-connect' ||
      !nextPort
    ) return;
    window.removeEventListener('message', connect);
    applyContext(message.context);
    port = nextPort;
    port.onmessage = responseEvent => {
      const response = responseEvent.data;

      if (response?.type === 'context') {
        applyContext(response.context);
        return;
      }
      if (
        response?.type === 'agent-panel-wheel' &&
        typeof response.key === 'string' &&
        anchoredAgentPanels.has(response.key) &&
        typeof response.deltaX === 'number' &&
        Number.isFinite(response.deltaX) &&
        typeof response.deltaY === 'number' &&
        Number.isFinite(response.deltaY)
      ) {
        scrollInlineAgentPage(
          anchoredAgentPanels.get(response.key).presentation,
          response.deltaX,
          response.deltaY,
        );
        return;
      }
      if (response?.type !== 'result' || typeof response.requestId !== 'string') return;
      const request = pending.get(response.requestId);
      if (!request) return;
      pending.delete(response.requestId);
      if (response.ok) request.resolve(response.result);
      else request.reject(Object.assign(new Error(response.error || 'Plugin command failed'), { handledByHost: response.handledByHost === true }));
    };
    port.start();
    resolveReady(context);
    port.postMessage({ type: 'ready' });
    // Dialogs in the sandbox cannot cover Agent overlays in the parent document.
    syncPageModal();
    const modalObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(syncPageModal)
      : null;
    modalObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['open'],
      childList: true,
      subtree: true,
    });
    document.addEventListener('toggle', syncPageModal, true);
    document.addEventListener('close', syncPageModal, true);
  };
  window.addEventListener('message', connect);
  window.parent.postMessage({ type: 'mearl-plugin-ready' }, '*');
})();`;

const PAGE_SECURITY_META =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">";

const PAGE_THEME_STYLE = `<style data-mearl-theme>
:root {
  color-scheme: light dark;
  --mearl-toolbar: #f3f3f3;
  --mearl-toolbar-border: #d0d0d0;
  --mearl-text-primary: #2c2c2c;
  --mearl-text-secondary: #6e6e6e;
  --mearl-bg-primary: #ffffff;
  --mearl-bg-secondary: #f8f9fa;
  --mearl-bg-list: #fafbfc;
  --mearl-bg-hover: #f0f1f3;
  --mearl-bg-selected: #f5f5f5;
  --mearl-border: #e1e4e8;
  --mearl-accent: #2a57c9;
  --mearl-accent-hover: #1d4ed8;
  --mearl-action-primary: oklch(54.6% 0.245 262.881);
  --mearl-action-primary-hover: oklch(48.8% 0.243 264.376);
  --mearl-action-primary-text: #ffffff;
  --mearl-danger: #dc2626;
  --mearl-danger-bg: rgb(220 38 38 / 8%);
  --mearl-success: #16a34a;
  --mearl-scrollbar-track: #f6f8fa;
  --mearl-scrollbar-thumb: #d1d5db;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--mearl-bg-primary);
}
:root[data-mearl-theme="dark"] {
  color-scheme: dark;
  --mearl-toolbar: #1f1f1f;
  --mearl-toolbar-border: #343434;
  --mearl-text-primary: #e4e4e7;
  --mearl-text-secondary: #a1a1aa;
  --mearl-bg-primary: #0f0f0f;
  --mearl-bg-secondary: #1a1a1a;
  --mearl-bg-list: #0f0f0f;
  --mearl-bg-hover: #262626;
  --mearl-bg-selected: #1f1f1f;
  --mearl-border: #30363d;
  --mearl-accent: #58a6ff;
  --mearl-accent-hover: #79b8ff;
  --mearl-danger: #f87171;
  --mearl-danger-bg: rgb(248 113 113 / 10%);
  --mearl-success: #4ade80;
  --mearl-scrollbar-track: #1a1a1a;
  --mearl-scrollbar-thumb: #3b3b3b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-mearl-theme="light"]) {
    color-scheme: dark;
    --mearl-toolbar: #1f1f1f;
    --mearl-toolbar-border: #343434;
    --mearl-text-primary: #e4e4e7;
    --mearl-text-secondary: #a1a1aa;
    --mearl-bg-primary: #0f0f0f;
    --mearl-bg-secondary: #1a1a1a;
    --mearl-bg-list: #0f0f0f;
    --mearl-bg-hover: #262626;
    --mearl-bg-selected: #1f1f1f;
    --mearl-border: #30363d;
    --mearl-accent: #58a6ff;
    --mearl-accent-hover: #79b8ff;
    --mearl-danger: #f87171;
    --mearl-danger-bg: rgb(248 113 113 / 10%);
    --mearl-success: #4ade80;
    --mearl-scrollbar-track: #1a1a1a;
    --mearl-scrollbar-thumb: #3b3b3b;
  }
}
body {
  margin: 0;
  background: var(--mearl-bg-primary);
  color: var(--mearl-text-primary);
}
button, input, select, textarea { font: inherit; }
</style>`;

export const PLUGIN_PAGE_RUNTIME_HASH = createHash('sha256')
  .update(PAGE_BRIDGE_SCRIPT)
  .update(PAGE_SECURITY_META)
  .update(PAGE_THEME_STYLE)
  .digest('hex');

function pluginRoot(entry: string): string {
  const entryDirectory = dirname(entry);
  return basename(entryDirectory) === 'scripts' ? dirname(entryDirectory) : entryDirectory;
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function removeAttribute(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s+${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i'), '');
}

function isEmbeddedReference(reference: string): boolean {
  return /^(?:data:|blob:|#)/i.test(reference.trim());
}

function isRemoteReference(reference: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference.trim());
}

function contentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function escapeStyleText(value: string): string {
  return value.replace(/<\/style/gi, '\\3C /style');
}

function escapeScriptText(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

export function buildPluginPageBundle(entry: string, pageEntry: string): BuiltPluginPageBundle {
  const root = realpathSync(pluginRoot(entry));
  let sourceBytes = 0;
  const countedFiles = new Set<string>();
  const sources: Record<string, string> = {};

  const resolveLocalFile = (reference: string, fromFile: string): string => {
    const cleanReference = reference.trim().split(/[?#]/, 1)[0];
    if (!cleanReference || isEmbeddedReference(cleanReference)) return '';
    if (isRemoteReference(cleanReference) || isAbsolute(cleanReference)) {
      throw new Error(`toolbox.page 不允许远程或绝对资源: ${reference}`);
    }
    const sourcePath = resolve(dirname(fromFile), cleanReference);
    const resolved = realpathSync(sourcePath);
    const relativePath = relative(root, resolved);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`toolbox.page 资源超出插件目录: ${reference}`);
    }
    sources[sourcePath] = pluginFileVersion(sourcePath);
    return resolved;
  };

  const readAsset = (path: string): Buffer => {
    sources[path] ??= pluginFileVersion(path);
    const content = readFileSync(path);
    if (!countedFiles.has(path)) {
      countedFiles.add(path);
      sourceBytes += content.byteLength;
      if (sourceBytes > MAX_PAGE_SOURCE_BYTES) {
        throw new Error('toolbox.page 源文件总大小不能超过 16 MiB');
      }
    }
    return content;
  };

  const dataUrl = (reference: string, fromFile: string): string => {
    if (isEmbeddedReference(reference)) return reference;
    const path = resolveLocalFile(reference, fromFile);
    return `data:${contentType(path)};base64,${readAsset(path).toString('base64')}`;
  };

  const inlineCss = (css: string, cssPath: string): string =>
    css.replace(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi, (_match, _quote, reference: string) => {
      const value = reference.trim();
      if (isEmbeddedReference(value)) return `url("${value}")`;
      return `url("${dataUrl(value, cssPath)}")`;
    });

  const absoluteEntry = resolveLocalFile(pageEntry, join(root, '__toolbox_entry__'));
  if (extname(absoluteEntry).toLowerCase() !== '.html') {
    throw new Error('toolbox.page.entry 必须指向 HTML 文件');
  }
  let html = readAsset(absoluteEntry)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  if (!/<html\b|<!doctype\b/i.test(html)) {
    throw new Error('toolbox.page.entry 必须是完整 HTML 文档');
  }
  if (/<base\b/i.test(html)) throw new Error('toolbox.page 不允许声明 base 标签');
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/i.test(html)) {
    throw new Error('toolbox.page 的安全策略由 Mearl 管理，请移除 CSP meta 标签');
  }

  html = html.replace(/<link\b[^>]*>/gi, tag => {
    const rel = attributeValue(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    const href = attributeValue(tag, 'href');
    if (rel.includes('stylesheet')) {
      if (!href) throw new Error('toolbox.page stylesheet 缺少 href');
      const cssPath = resolveLocalFile(href, absoluteEntry);
      const css = inlineCss(readAsset(cssPath).toString('utf8'), cssPath);
      return `<style data-mearl-source="${href.replaceAll('"', '&quot;')}">${escapeStyleText(css)}</style>`;
    }
    if (href && rel.some(value => ['icon', 'apple-touch-icon'].includes(value))) {
      return tag.replace(href, dataUrl(href, absoluteEntry));
    }
    if (href && isRemoteReference(href)) {
      throw new Error(`toolbox.page 不允许远程 link 资源: ${href}`);
    }
    return tag;
  });

  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, tag => {
    const src = attributeValue(tag, 'src');
    if (!src) return tag;
    const scriptPath = resolveLocalFile(src, absoluteEntry);
    const script = readAsset(scriptPath).toString('utf8');
    if (
      attributeValue(tag, 'type')?.toLowerCase() === 'module' &&
      /(?:^|[;\n]\s*)(?:import\s|export\s)|\bimport\s*\(/m.test(script)
    ) {
      throw new Error('toolbox.page 的模块脚本必须先打包为无 import 的单文件');
    }
    const openingTag = removeAttribute(tag.slice(0, tag.indexOf('>') + 1), 'src');
    return `${openingTag}${escapeScriptText(script)}</script>`;
  });

  html = html.replace(
    /(<(?:img|source|video|audio|track|input)\b[^>]*?\s(?:src|poster)\s*=\s*)(["'])([^"']+)\2/gi,
    (_match, prefix: string, quote: string, reference: string) =>
      `${prefix}${quote}${dataUrl(reference, absoluteEntry)}${quote}`,
  );

  const injection = `<meta name="color-scheme" content="light dark">${PAGE_SECURITY_META}${PAGE_THEME_STYLE}<script data-mearl-bridge>${escapeScriptText(PAGE_BRIDGE_SCRIPT)}</script>`;
  html = /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, tag => `${tag}${injection}`)
    : html.replace(/<html\b[^>]*>/i, tag => `${tag}<head>${injection}</head>`);

  const content = html;
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength > MAX_PAGE_BUNDLE_BYTES) {
    throw new Error('toolbox.page 打包后不能超过 24 MiB');
  }
  return {
    content,
    hash: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.byteLength,
    chunks: Math.ceil(buffer.byteLength / PLUGIN_PAGE_CHUNK_BYTES),
    sources,
  };
}
