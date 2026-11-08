// 页面元素信息采集：MAIN world 暴露给 DevTools panel，同时供 content script 的元素拾取器复用。

// 需要采集的 CSS 属性白名单（布局相关）
const LAYOUT_PROPS = [
  'display',
  'position',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'overflow',
  'overflowX',
  'overflowY',
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'alignItems',
  'alignContent',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'flex',
  'alignSelf',
  'order',
  'gridTemplateColumns',
  'gridTemplateRows',
  'gridColumn',
  'gridRow',
  'gap',
  'rowGap',
  'columnGap',
  'boxSizing',
  'zIndex',
  'top',
  'right',
  'bottom',
  'left',
  'transform',
  'opacity',
  'visibility',
  'float',
  'clear',
  'whiteSpace',
  'textOverflow',
  'wordBreak',
  'pointerEvents',
  'cursor',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'borderRadius',
  'borderColor',
  'borderWidth',
  'color',
  'backgroundColor',
] as const;

// 默认值，不纳入 computedStyle 输出（减少噪音）
const DEFAULT_VALUES = new Set(['normal', 'none', 'auto', 'initial', 'unset', 'revert']);

// 需要保留的属性名（data-* 之外的固定属性）
const ATTR_NAMES = new Set([
  'id',
  'class',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-expanded',
  'type',
  'href',
  'src',
  'style',
  'name',
  'for',
]);

function buildSelectorParts(el: Element): string[] {
  const escapeCss = (value: string): string =>
    globalThis.CSS && typeof globalThis.CSS.escape === 'function'
      ? globalThis.CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 32) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) part += '#' + escapeCss(cur.id);
    const classes = Array.from(cur.classList).slice(0, 3);
    if (!cur.id && classes.length) part += '.' + classes.map(escapeCss).join('.');
    // Add :nth-child when siblings share the same tag+classes to ensure uniqueness
    const parent = cur.parentElement;
    if (parent) {
      const clsStr = classes.join('.');
      const siblings = Array.from(parent.children);
      const ambiguous = siblings.filter(s => {
        if (s.tagName !== cur!.tagName) return false;
        return Array.from(s.classList).slice(0, 3).join('.') === clsStr;
      });
      if (ambiguous.length > 1) {
        const idx = siblings.indexOf(cur) + 1;
        part += `:nth-child(${idx})`;
      }
    }
    parts.unshift(part);
    try {
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
    } catch {}
    cur = cur.parentElement;
  }
  return parts;
}

function getXPath(node: Element): string {
  const parts: string[] = [];
  let n: Element | null = node;
  while (n) {
    const tag = n.tagName.toLowerCase();
    let idx = 1;
    let sib = n.previousSibling;
    while (sib) {
      if (sib.nodeType === 1 && (sib as Element).tagName === n.tagName) idx++;
      sib = sib.previousSibling;
    }
    parts.unshift(idx > 1 ? `${tag}[${idx}]` : tag);
    n = n.parentElement;
    if (parts.length >= 12) {
      parts.unshift('...');
      break;
    }
  }
  return '/' + parts.join('/');
}

function getReactComponentStack(el: Element): string[] {
  const stack: string[] = [];
  const fiberKey = Object.keys(el).find(
    k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
  );
  if (!fiberKey) return stack;

  let fiber = (el as any)[fiberKey];
  let visited = 0;
  while (fiber && visited < 40) {
    visited++;
    const type = fiber.type;
    let name: string | null = null;
    if (typeof type === 'function' || (typeof type === 'object' && type !== null)) {
      name = type.displayName || type.name || null;
    }
    if (name && name !== 'Anonymous' && !stack.includes(name)) stack.push(name);
    if (stack.length >= 8) break;
    fiber = fiber.return;
  }
  return stack;
}

function getVueComponentName(el: Element): string | null {
  let node: Element | null = el;
  while (node) {
    const comp = (node as any).__vueParentComponent;
    if (comp) {
      const name = comp.type?.name || comp.type?.__name || comp.type?.displayName || null;
      if (name) return name as string;
      if (comp.appContext) break;
    }
    node = node.parentElement;
    if (!node || node === document.body) break;
  }
  return null;
}

function getSourceLocation(el: Element): string | null {
  const fromAttr =
    el.getAttribute('data-source-location') || el.getAttribute('data-source') || null;
  if (fromAttr) return fromAttr;

  const fiberKey = Object.keys(el).find(
    k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
  );
  if (fiberKey) {
    let f = (el as any)[fiberKey];
    let visited = 0;
    while (f && visited < 10) {
      visited++;
      if (f._debugSource) {
        const ds = f._debugSource;
        return `${ds.fileName}:${ds.lineNumber}${ds.columnNumber != null ? ':' + ds.columnNumber : ''}`;
      }
      f = f.return;
    }
  }
  return null;
}

/**
 * 采集当前元素的结构化信息，供 DevTools 的 $0 查询和页面元素拾取共用。
 */
export function collectElementData(el: Element | null, includeOuterHTML = true) {
  if (!el || el.nodeType !== 1) return null;

  const domRect = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);

  // 采集 CSS 并过滤默认值
  const computedStyle: Record<string, string> = {};
  for (const key of LAYOUT_PROPS) {
    const val: string = (cs as any)[key] || '';
    if (val && !DEFAULT_VALUES.has(val)) computedStyle[key] = val;
  }

  // 采集属性并过滤白名单
  const attributes: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-') || ATTR_NAMES.has(attr.name)) {
      attributes[attr.name] = attr.value.substring(0, 300);
    }
  }

  // rect 取整
  const rect = {
    x: Math.round(domRect.x),
    y: Math.round(domRect.y),
    width: Math.round(domRect.width),
    height: Math.round(domRect.height),
    top: Math.round(domRect.top),
    right: Math.round(domRect.right),
    bottom: Math.round(domRect.bottom),
    left: Math.round(domRect.left),
  };

  // 框架信息：只在有值时输出
  const reactStack = getReactComponentStack(el);
  const vueName = getVueComponentName(el);
  const framework: Record<string, any> = {};
  if (reactStack.length > 0) framework.react = { componentStack: reactStack };
  if (vueName) framework.vue = { componentName: vueName };

  const selectorParts = buildSelectorParts(el);
  const sourceLocation = getSourceLocation(el);

  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || null,
    className: (typeof el.className === 'string' ? el.className : null) || null,
    selector: selectorParts.join(' > '),
    xpath: getXPath(el),
    ...(sourceLocation ? { sourceLocation } : {}),
    ...(Object.keys(framework).length > 0 ? { framework } : {}),
    rect,
    computedStyle,
    attributes,
    textContent: (el.textContent || '').substring(0, 500),
    outerHTML: includeOuterHTML ? (el.outerHTML || '').substring(0, 3000) : undefined,
    childCount: el.childElementCount,
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  };
}

const PICKED_ELEMENT_ATTR = 'data-mtop-element-target';

export function installElementCollectorBridge(): void {
  window.addEventListener('message', event => {
    const data = event.data;
    if (
      event.source !== window ||
      data?.source !== 'mearl-content' ||
      data?.type !== 'COLLECT_PICKED_ELEMENT' ||
      typeof data.requestId !== 'string' ||
      !/^[a-zA-Z0-9_]+$/.test(data.requestId)
    ) {
      return;
    }

    const tagged = document.querySelector(`[${PICKED_ELEMENT_ATTR}="${data.requestId}"]`);
    const pointTarget =
      !tagged && typeof data.x === 'number' && typeof data.y === 'number'
        ? document.elementFromPoint(data.x, data.y)
        : null;
    const target = tagged || pointTarget;
    if (tagged) tagged.removeAttribute(PICKED_ELEMENT_ATTR);

    let element = null;
    try {
      element = collectElementData(target, true);
    } catch {
      // 详细信息采集失败时由 content script 回退到可见文本。
    }
    window.postMessage(
      {
        source: 'mearl-injected',
        type: 'PICKED_ELEMENT_RESULT',
        requestId: data.requestId,
        element,
      },
      '*',
    );
  });
}

export type ElementInfo = NonNullable<ReturnType<typeof collectElementData>>;
