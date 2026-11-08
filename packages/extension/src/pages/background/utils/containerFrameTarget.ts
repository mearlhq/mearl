/**
 * 容器栈顶 frame 解析
 *
 * 当 tab 处于 app-profile 容器模拟态时，首个业务页面位于
 * name="__mearl_root__" 的根 WebView，open 出的后续页面位于一组
 * name="__mearl_layer__" 的 iframe。本模块在 agent 操作时解析当前业务 frame，
 * 让 snapshot / click / eval 等动作透明代理到用户正在看的页面。
 *
 * 判定逻辑：
 * - tab 有活跃 app-profile 配置或设备外壳
 * - 从栈顶向下选择未退出交互树的 WebView
 * - 动画期间没有可交互层时，等待容器栈完成状态切换
 * - 无 layer 时回落到 root WebView
 */

import { getAppProfileForTab } from './appProfileRules';
import { acquireDebuggerLease } from '../debuggerSessionManager';
import { getDeviceShellForTab } from '../deviceShellRules';
import { listBusinessWebViewSessions } from '../backgroundRequestCollector';

const ROOT_FRAME_NAME = '__mearl_root__';
const LAYER_FRAME_NAME = '__mearl_layer__';

export interface FrameTreeNode {
  frame: { id: string; parentId?: string; url: string; name?: string };
  childFrames?: FrameTreeNode[];
  sessionId?: string;
}

export interface ContainerFrameTarget {
  frameId: string;
  url: string;
  phoneFrame?: boolean;
  sessionId?: string;
}

export interface FrameViewportTransform extends ContainerFrameTarget {
  outerOwnerBackendNodeId?: number;
  offset: { x: number; y: number };
  scale: { x: number; y: number };
  viewport: { width: number; height: number };
}

interface FrameOwnerGeometry {
  backendNodeId: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
}

const FRAME_INTERACTIVITY_SETTLE_TIMEOUT_MS = 420;
const FRAME_INTERACTIVITY_POLL_MS = 20;
const FRAME_RELOAD_TIMEOUT_MS = 30_000;

export function findFrameNode(node: FrameTreeNode, frameId: string): FrameTreeNode | undefined {
  if (node.frame.id === frameId) return node;
  for (const child of node.childFrames ?? []) {
    const match = findFrameNode(child, frameId);
    if (match) return match;
  }
  return undefined;
}

function indexFrames(node: FrameTreeNode, frames: Map<string, FrameTreeNode>): void {
  frames.set(node.frame.id, node);
  for (const child of node.childFrames ?? []) indexFrames(child, frames);
}

export function frameDebuggee(tabId: number, frame?: { sessionId?: string }) {
  return { tabId, ...(frame?.sessionId ? { sessionId: frame.sessionId } : {}) };
}

export async function hitsFrameOwner(tabId: number, backendNodeId: number, x: number, y: number): Promise<boolean> {
  const target = { tabId };
  const { object } = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId }) as {
    object?: { objectId?: string };
  };
  if (!object?.objectId) return false;
  const { objectId } = object;
  try {
    const { result } = await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(x,y) { return this.ownerDocument.elementFromPoint(x,y) === this; }',
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    }) as { result?: { value?: boolean } };
    return result?.value === true;
  } finally {
    await chrome.debugger.sendCommand(target, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

export async function readFrameTree(tabId: number): Promise<FrameTreeNode> {
  const read = async (sessionId?: string) => {
    const { frameTree } = await chrome.debugger.sendCommand(
      frameDebuggee(tabId, { sessionId }), 'Page.getFrameTree',
    ) as { frameTree: FrameTreeNode };
    if (sessionId) {
      const mark = (node: FrameTreeNode): void => {
        node.sessionId = sessionId;
        node.childFrames?.forEach(mark);
      };
      mark(frameTree);
    }
    return frameTree;
  };
  const [root, children] = await Promise.all([
    read(),
    Promise.all(listBusinessWebViewSessions(tabId).map(session => read(session).catch(() => undefined))),
  ]);
  const frames = new Map<string, FrameTreeNode>();
  indexFrames(root, frames);
  for (const child of children) if (child) indexFrames(child, frames);
  for (const child of children) {
    const parent = child?.frame.parentId && frames.get(child.frame.parentId);
    if (!child || !parent) continue;
    parent.childFrames = [...(parent.childFrames ?? []).filter(node => node.frame.id !== child.frame.id), child];
  }
  return root;
}

async function readFrameOwnerInteractivity(
  debugTarget: chrome.debugger.Debuggee,
  frameId: string,
): Promise<boolean | undefined> {
  try {
    const owner = (await chrome.debugger.sendCommand(debugTarget, 'DOM.getFrameOwner', {
      frameId,
    })) as { backendNodeId?: number };
    if (owner.backendNodeId === undefined) return undefined;
    const described = (await chrome.debugger.sendCommand(debugTarget, 'DOM.describeNode', {
      backendNodeId: owner.backendNodeId,
      depth: 0,
    })) as { node?: { attributes?: string[] } };
    const attributes = described.node?.attributes;
    if (!attributes) return undefined;
    const names = new Set(attributes.filter((_, index) => index % 2 === 0));
    const ariaHiddenIndex = attributes.indexOf('aria-hidden');
    return (
      !names.has('inert') && (ariaHiddenIndex < 0 || attributes[ariaHiddenIndex + 1] !== 'true')
    );
  } catch {
    return undefined;
  }
}

async function selectInteractiveContainerFrame(
  tabId: number,
  phoneFrame: boolean,
): Promise<ContainerFrameTarget | undefined> {
  const deadline = Date.now() + FRAME_INTERACTIVITY_SETTLE_TIMEOUT_MS;
  let fallback: FrameTreeNode | undefined;
  do {
    const tree = await readFrameTree(tabId);
    const layers: FrameTreeNode[] = [];
    let root: FrameTreeNode | undefined;
    const collect = (node: FrameTreeNode) => {
      for (const child of node.childFrames ?? []) {
        if (child.frame.name === ROOT_FRAME_NAME) root = child;
        else if (child.frame.name === LAYER_FRAME_NAME) layers.push(child);
        collect(child);
      }
    };
    collect(tree);
    const candidates = root ? [root, ...layers] : layers;
    fallback = candidates.at(-1);
    let inspected = false;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      const parent = candidate.frame.parentId ? findFrameNode(tree, candidate.frame.parentId) : undefined;
      const interactive = await readFrameOwnerInteractivity(frameDebuggee(tabId, parent), candidate.frame.id);
      if (interactive === undefined) continue;
      inspected = true;
      if (interactive) return frameTarget(candidate);
    }
    if ((!inspected && !phoneFrame) || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, FRAME_INTERACTIVITY_POLL_MS));
  } while (Date.now() < deadline);
  return !phoneFrame && fallback ? frameTarget(fallback) : undefined;
}

function frameTarget(node: FrameTreeNode): ContainerFrameTarget {
  return { frameId: node.frame.id, url: node.frame.url, ...(node.sessionId ? { sessionId: node.sessionId } : {}) };
}

async function readFrameOwnerGeometry(
  debugTarget: chrome.debugger.Debuggee,
  frameId: string,
): Promise<FrameOwnerGeometry> {
  const owner = (await chrome.debugger.sendCommand(debugTarget, 'DOM.getFrameOwner', {
    frameId,
  })) as { backendNodeId?: number };
  if (owner.backendNodeId === undefined) {
    throw new Error(`Cannot resolve frame owner for ${frameId}`);
  }
  const resolved = (await chrome.debugger.sendCommand(debugTarget, 'DOM.resolveNode', {
    backendNodeId: owner.backendNodeId,
  })) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error(`Cannot resolve frame owner element for ${frameId}`);
  try {
    const result = (await chrome.debugger.sendCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        const rect = this.getBoundingClientRect();
        const offsetWidth = this.offsetWidth || rect.width || 1;
        const offsetHeight = this.offsetHeight || rect.height || 1;
        const scaleX = rect.width / offsetWidth;
        const scaleY = rect.height / offsetHeight;
        return {
          x: rect.left + (this.clientLeft || 0) * scaleX,
          y: rect.top + (this.clientTop || 0) * scaleY,
          scaleX,
          scaleY,
          width: this.clientWidth,
          height: this.clientHeight
        };
      }`,
      returnByValue: true,
    })) as { result?: { value?: Omit<FrameOwnerGeometry, 'backendNodeId'> } };
    const geometry = result.result?.value;
    if (
      !geometry ||
      !Number.isFinite(geometry.x) ||
      !Number.isFinite(geometry.y) ||
      !Number.isFinite(geometry.scaleX) ||
      !Number.isFinite(geometry.scaleY) ||
      geometry.width <= 0 ||
      geometry.height <= 0
    ) {
      throw new Error(`Frame owner geometry is unavailable for ${frameId}`);
    }
    return { ...geometry, backendNodeId: owner.backendNodeId };
  } finally {
    await chrome.debugger
      .sendCommand(debugTarget, 'Runtime.releaseObject', { objectId })
      .catch(() => {});
  }
}

/**
 * 返回当前业务 WebView；非容器模式或尚未创建业务 frame 时返回 undefined。
 */
export async function getContainerTopFrame(
  tabId: number,
  scope: 'container' | 'phone-frame' = 'container',
): Promise<ContainerFrameTarget | undefined> {
  const [config, deviceShell] = await Promise.all([
    scope === 'container' ? getAppProfileForTab(tabId) : undefined,
    getDeviceShellForTab(tabId),
  ]);
  const phoneFrame = Boolean(deviceShell?.config.phoneFrame);
  if (scope === 'phone-frame' ? !phoneFrame : !config && !deviceShell) return undefined;

  const lease = await acquireDebuggerLease(tabId, {
    consumer: 'container-frame-target',
    domains: ['Page'],
  });
  try {
    const active = await selectInteractiveContainerFrame(tabId, phoneFrame);
    if (active) return phoneFrame ? { ...active, phoneFrame } : active;
    if (phoneFrame) throw new Error('The device preview page is not ready. Retry after it loads.');
    return undefined;
  } catch (error) {
    if (phoneFrame) throw error;
    return undefined;
  } finally {
    await lease.release();
  }
}

/**
 * 重载当前可交互的业务 WebView，并保留外层设备壳和容器层展示状态。
 * Page.reload 只能作用于 target 主 frame；对子 frame 按当前 URL 重新导航，等价于刷新
 * WebView 内容，同时不会销毁承载半弹层样式、遮罩和容器历史的父文档。
 */
export async function reloadContainerTopFrame(
  tabId: number,
  options: { singleRoot?: boolean; beforeNavigate?: (target: ContainerFrameTarget) => Promise<(() => void) | undefined> } = {},
): Promise<ContainerFrameTarget | undefined> {
  const target = await getContainerTopFrame(tabId);
  if (!target) return undefined;

  let rejectOnInvalidation: ((error: Error) => void) | undefined;
  const lease = await acquireDebuggerLease(tabId, {
    consumer: 'container-frame-reload',
    domains: ['Page'],
    onInvalidated: reason => {
      rejectOnInvalidation?.(
        new Error(
          `Container frame reload debugger session was invalidated${reason ? `: ${reason}` : ''}`,
        ),
      );
    },
  });
  let cancelNavigation: (() => void) | undefined;
  try {
    if (options.singleRoot) {
      const tree = await readFrameTree(tabId);
      const containsLayer = (node: FrameTreeNode): boolean =>
        node.frame.name === LAYER_FRAME_NAME || (node.childFrames?.some(containsLayer) ?? false);
      if (findFrameNode(tree, target.frameId)?.frame.name !== ROOT_FRAME_NAME || containsLayer(tree)) return;
    }
    cancelNavigation = await options.beforeNavigate?.(target);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let navigationStarted = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        rejectOnInvalidation = undefined;
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
        if (error) reject(error);
        else resolve();
      };
      const listener = (source: chrome.debugger.Debuggee, method: string, params?: any) => {
        if (source.tabId !== tabId || params?.frameId !== target.frameId) return;
        if (method === 'Page.frameStartedLoading') {
          navigationStarted = true;
          return;
        }
        if (method === 'Page.frameStoppedLoading' && navigationStarted) finish();
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `Container frame load timeout after ${FRAME_RELOAD_TIMEOUT_MS}ms: ${target.url}`,
            ),
          ),
        FRAME_RELOAD_TIMEOUT_MS,
      );
      rejectOnInvalidation = finish;
      chrome.debugger.onEvent.addListener(listener);
      void chrome.debugger
        .sendCommand(frameDebuggee(tabId, target), 'Page.navigate', {
          url: target.url,
          frameId: target.frameId,
        })
        .then(result => {
          const errorText = (result as { errorText?: string } | undefined)?.errorText;
          if (errorText) finish(new Error(`Container frame reload failed: ${errorText}`));
        })
        .catch(error => finish(error instanceof Error ? error : new Error(String(error))));
    });
    return target;
  } finally {
    cancelNavigation?.();
    rejectOnInvalidation = undefined;
    await lease.release();
  }
}

/** 返回指定 frame 的 URL；frame 不存在时返回 undefined。 */
export async function getFrameTarget(
  tabId: number,
  frameId: string,
  withinFrameId?: string,
): Promise<ContainerFrameTarget | undefined> {
  const lease = await acquireDebuggerLease(tabId, {
    consumer: 'frame-target',
    domains: ['Page'],
  });
  try {
    const tree = await readFrameTree(tabId);
    const scope = withinFrameId ? findFrameNode(tree, withinFrameId) : tree;
    const node = scope && findFrameNode(scope, frameId);
    return node ? frameTarget(node) : undefined;
  } finally {
    await lease.release();
  }
}

/**
 * 将 frame 视口坐标映射到顶层页面视口。每一层 iframe 的边框、偏移与轴向缩放
 * 都参与组合，供 CDP Input 和视口裁剪共享同一套坐标契约。
 */
export async function getFrameViewportTransform(
  tabId: number,
  frameId: string,
): Promise<FrameViewportTransform> {
  const debugTarget = { tabId };
  const lease = await acquireDebuggerLease(tabId, {
    consumer: 'frame-viewport-transform',
    domains: ['Page', 'Runtime'],
  });
  try {
    const tree = await readFrameTree(tabId);
    const frames = new Map<string, FrameTreeNode>();
    indexFrames(tree, frames);
    const target = frames.get(frameId);
    if (!target) throw new Error(`Frame ${frameId} is not present in the current page`);

    let current = target;
    let offsetX = 0;
    let offsetY = 0;
    let scaleX = 1;
    let scaleY = 1;
    let viewport: { width: number; height: number } | undefined;
    let outerOwnerBackendNodeId: number | undefined;

    while (current.frame.parentId) {
      const parent = frames.get(current.frame.parentId);
      if (!parent) throw new Error(`Cannot resolve parent of ${current.frame.id}`);
      const owner = await readFrameOwnerGeometry(frameDebuggee(tabId, parent), current.frame.id);
      outerOwnerBackendNodeId = owner.backendNodeId;
      viewport ??= { width: owner.width, height: owner.height };
      offsetX = owner.x + offsetX * owner.scaleX;
      offsetY = owner.y + offsetY * owner.scaleY;
      scaleX *= owner.scaleX;
      scaleY *= owner.scaleY;
      current = parent;
    }

    if (!viewport) {
      const evaluated = (await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
        expression: `({ width: window.innerWidth, height: window.innerHeight })`,
        returnByValue: true,
      })) as { result?: { value?: { width?: number; height?: number } } };
      const width = evaluated.result?.value?.width;
      const height = evaluated.result?.value?.height;
      if (typeof width !== 'number' || typeof height !== 'number') {
        throw new Error(`Viewport geometry is unavailable for ${frameId}`);
      }
      viewport = { width, height };
    }

    return {
      ...frameTarget(target),
      ...(outerOwnerBackendNodeId !== undefined ? { outerOwnerBackendNodeId } : {}),
      offset: { x: offsetX, y: offsetY },
      scale: { x: scaleX, y: scaleY },
      viewport,
    };
  } finally {
    await lease.release();
  }
}

/**
 * 判断 tab 是否处于容器模拟态（不解析 frame tree，仅检查配置存在性）。
 */
export async function isContainerTab(tabId: number): Promise<boolean> {
  return Boolean(await getAppProfileForTab(tabId));
}
