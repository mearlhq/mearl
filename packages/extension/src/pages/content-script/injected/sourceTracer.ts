// Source Tracer (MAIN world)
// 1) 接收 content-script 发来的 TRACE_ELEMENT 请求
// 2) 找到带 data-mtop-trace-target 的 DOM 节点
// 3) 沿 React fiber 向上回溯，提取 props 候选值 + 源码位置 + 组件名
// 4) 把结果回发给 content-script，转发到 panel
//
// 这个模块不依赖 React 的内部 API，只读 DOM 节点上的 __reactFiber$xxx 属性。

interface SourceLocation {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
}

interface TraceCandidate {
  value: unknown;
  from: 'props' | 'text';
  propPath: string[];
  depth: number;
}

interface TraceResultPayload {
  ok: boolean;
  reason?: string;
  componentName?: string;
  sourceLocation?: SourceLocation;
  candidates: TraceCandidate[];
  elementInfo: {
    tag: string;
    text: string;
    selector: string;
    semanticSelector: string;
    attrs: Array<{ name: string; value: string }>;
  };
  pageInfo: {
    url: string;
    pathname: string;
  };
}

const TRACE_ATTR = 'data-mtop-trace-target';
const HIGHLIGHT_ID = '__mtop_trace_reverse_highlight__';
const MAX_DEPTH = 3;
const MAX_CANDIDATES = 40;
const MAX_STRING_LEN = 200;

// 表单类元素提取用户可见的文本：input/textarea 用 value、select 用 option.text
// 优先级用于 elementInfo.text 显示和 collectCandidates 兜底
function getFormControlText(el: Element): string {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '✓' : '';
    if (el.type === 'password') return ''; // 不抓密码
    return el.value || '';
  }
  if (el instanceof HTMLTextAreaElement) return el.value || '';
  if (el instanceof HTMLSelectElement) {
    const opt = el.options[el.selectedIndex];
    return opt?.text || opt?.value || '';
  }
  return '';
}

// 计算元素的"用户可见文本"，优先级：表单 value > innerText > textContent > placeholder
function getVisibleText(el: Element): string {
  const formText = getFormControlText(el);
  if (formText) return formText;
  const inner = (el as HTMLElement).innerText?.trim();
  if (inner) return inner;
  const tc = el.textContent?.trim();
  if (tc) return tc;
  const ph = (el as HTMLInputElement).placeholder;
  if (ph) return ph;
  return '';
}

export function getReactFiberOn(node: Node): any {
  // 直接读 own properties（含不可枚举），覆盖 React 16+、React 15、以及部分 Rax 场景
  const names = Object.getOwnPropertyNames(node);
  for (const key of names) {
    if (
      key.startsWith('__reactFiber$') ||
      key.startsWith('__reactInternalInstance$') ||
      key.startsWith('__reactProps$')
    ) {
      const v = (node as any)[key];
      // __reactProps$ 单独存在时找不到 fiber，跳过
      if (key.startsWith('__reactProps$')) continue;
      return v;
    }
  }
  return null;
}

function getReactFiber(el: Element): { fiber: any; host: Element } | null {
  // 1. 元素自身
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 10) {
    const fiber = getReactFiberOn(cur);
    if (fiber) return { fiber, host: cur };
    cur = cur.parentElement;
    depth++;
  }
  return null;
}

function findOwnerWithDebugSource(fiber: any): any {
  let f = fiber;
  while (f) {
    if (f._debugSource) return f;
    f = f._debugOwner ?? f.return;
  }
  return null;
}

// React 19 起 _debugSource 被移除，元素创建时改捕获一个 Error 实例放到 _debugStack
function findOwnerWithDebugStack(fiber: any): any {
  let f = fiber;
  while (f) {
    const ds = f._debugStack;
    if (ds && (typeof ds === 'string' || typeof ds.stack === 'string')) return f;
    f = f._debugOwner ?? f.return;
  }
  return null;
}

// 判定一个帧 URL 是否「框架/构建器自身」（非用户代码）。
// 覆盖 Vite（node_modules/.vite、@vite/client）、webpack runtime、以及 Next.js dev
// 的 _debugStack 合成帧（react-stack-top/bottom-frame、node_modules/next/dist 内部帧）。
function isFrameworkFrame(url: string): boolean {
  if (!url || url === '<anonymous>') return true;
  return (
    /node_modules\//.test(url) ||
    /\/next\/dist\//.test(url) ||
    /react-stack-(top|bottom)-frame|fakeJSXCallSite/.test(url) ||
    /webpack\/runtime|__webpack_require__|@vite\/client|\/vite\/dist\//.test(url)
  );
}

// 把帧里的 URL 清洗成可读的项目相对/绝对路径。
// 处理 Next.js 的 webpack-internal:///(app-pages-browser)/./ 与
// rsc://React/Server/webpack-internal:///(rsc)/./ 前缀、(xxx)/ 构建分组目录、
// ./ 前缀、Vite 的 ?t= 时间戳查询串、以及 http(s):// host。
function cleanFrameUrl(url: string): string {
  return url
    .replace(/^rsc:\/\/React\/[^/]*\//, '')
    .replace(/^webpack-internal:\/\/\//, '')
    .replace(/^webpack:\/\//, '')
    .replace(/^\([^)]*\)\//, '')
    .replace(/^\.\//, '')
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\?[^#]*$/, '');
}

// 从 V8 栈的一行里解析出 { url, line, col }。
// 兼容 `    at Foo (url:line:col)`、`    at url:line:col` 两种格式，
// 且 URL 内部允许含括号（Next.js 的 (app-pages-browser)/(rsc) 等构建分组目录）——
// 这正是旧正则 [^()\s]+? 解析不出 Next.js 帧的原因。
function parseFrameLine(
  line: string,
): { url: string; lineNumber: number; columnNumber: number } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('at ')) return null;
  // 行尾的 :line:col（可能再跟一个包裹用的右括号）
  const loc = trimmed.match(/:(\d+):(\d+)\)?$/);
  if (!loc || loc.index === undefined) return null;
  let url = trimmed.slice(3, loc.index); // 去掉 "at " 与尾部 :line:col
  // 形如 `Foo (url`：用第一个 " (" 切掉函数名包裹，保留 URL 自身的括号
  const wrap = url.indexOf(' (');
  if (wrap !== -1) url = url.slice(wrap + 2);
  return { url, lineNumber: Number(loc[1]), columnNumber: Number(loc[2]) };
}

function parseStackForUserFrame(stack: string): SourceLocation | undefined {
  for (const line of stack.split('\n')) {
    const fr = parseFrameLine(line);
    if (!fr || isFrameworkFrame(fr.url)) continue;
    return {
      fileName: cleanFrameUrl(fr.url),
      lineNumber: fr.lineNumber,
      columnNumber: fr.columnNumber,
    };
  }
  return undefined;
}

function findOwnerComponent(fiber: any): any {
  let f = fiber;
  while (f) {
    if (typeof f.type === 'function' || (f.type && typeof f.type === 'object')) {
      return f;
    }
    f = f.return;
  }
  return null;
}

export function getComponentName(fiber: any): string | undefined {
  if (!fiber) return undefined;
  const t = fiber.type;
  if (typeof t === 'string') return t;
  if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
  if (t && typeof t === 'object') {
    if (t.displayName) return t.displayName;
    if (t.render && (t.render.displayName || t.render.name)) {
      return t.render.displayName || t.render.name;
    }
    if (t.type && (t.type.displayName || t.type.name)) {
      return t.type.displayName || t.type.name;
    }
  }
  return undefined;
}

function isPrimitive(v: unknown): boolean {
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}

function pushCandidate(out: TraceCandidate[], cand: TraceCandidate): void {
  if (out.length >= MAX_CANDIDATES) return;
  if (typeof cand.value === 'string' && cand.value.length > MAX_STRING_LEN) return;
  out.push(cand);
}

// React/DOM 控件属性 —— 这些键不可能携带"渲染出来的业务数据"
// 把它们的值放进候选只会污染匹配结果（disabled=false / placeholder=提示语 / aria-label 等）
const NOISE_PROP_KEYS = new Set([
  // React 内部
  'children',
  'key',
  'ref',
  'dangerouslySetInnerHTML',
  'suppressContentEditableWarning',
  'suppressHydrationWarning',
  // DOM 通用
  'className',
  'class',
  'style',
  'id',
  'role',
  'slot',
  'nonce',
  'dir',
  'lang',
  'tabIndex',
  'tabindex',
  'htmlFor',
  'htmlfor',
  'hidden',
  'draggable',
  'contentEditable',
  'contenteditable',
  // 表单控件
  'placeholder',
  'disabled',
  'readOnly',
  'readonly',
  'required',
  'checked',
  'defaultChecked',
  'selected',
  'multiple',
  'autoFocus',
  'autofocus',
  'autoComplete',
  'autocomplete',
  'autoCorrect',
  'autocorrect',
  'autoCapitalize',
  'autocapitalize',
  'spellCheck',
  'spellcheck',
  'inputMode',
  'inputmode',
  'enterKeyHint',
  'enterkeyhint',
  'pattern',
  'min',
  'max',
  'step',
  'minLength',
  'minlength',
  'maxLength',
  'maxlength',
  'size',
  'rows',
  'cols',
  'wrap',
  'form',
  'formAction',
  'formaction',
  'formMethod',
  'formmethod',
  'formNoValidate',
  'formnovalidate',
  'formTarget',
  'formtarget',
  // 媒体
  'loop',
  'muted',
  'autoPlay',
  'autoplay',
  'controls',
  'preload',
  // 'type' 通常是控件类型 (text/checkbox)，业务字段也会用 type，但更多是噪音；保守跳过
  'type',
  // 'name' 在 form 上是字段名，在自定义组件可能是数据；保守跳过，否则 "name=phone" 这种全匹响应字段
  'name',
]);

const NOISE_PRIMITIVE_VALUES = new Set(['true', 'false', 'null', 'undefined', '', 'NaN']);

function collectFromProps(
  obj: unknown,
  out: TraceCandidate[],
  propPath: string[],
  depth: number,
  seen: WeakSet<object>,
): void {
  if (depth > MAX_DEPTH) return;
  if (out.length >= MAX_CANDIDATES) return;
  if (obj == null) return;

  if (isPrimitive(obj)) {
    // 过滤明显噪音值
    if (typeof obj === 'boolean') return;
    if (typeof obj === 'string' && NOISE_PRIMITIVE_VALUES.has(obj)) return;
    if (typeof obj === 'number' && obj === 0) return;
    pushCandidate(out, { value: obj, from: 'props', propPath, depth });
    return;
  }

  if (typeof obj !== 'object') return;
  if (seen.has(obj as object)) return;
  seen.add(obj as object);

  // 跳过常见的非数据结构
  if (obj instanceof Element || obj instanceof Node) return;
  if (typeof (obj as any).$$typeof === 'symbol') return; // React element

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && i < 20; i++) {
      collectFromProps(obj[i], out, [...propPath, String(i)], depth + 1, seen);
    }
    return;
  }

  for (const key of Object.keys(obj as object)) {
    if (key.startsWith('_')) continue;
    if (key.startsWith('on') && /^[A-Z]/.test(key.charAt(2))) continue; // onClick/onChange...
    if (key.startsWith('aria-') || key.startsWith('data-')) continue;
    if (NOISE_PROP_KEYS.has(key)) continue;
    collectFromProps((obj as any)[key], out, [...propPath, key], depth + 1, seen);
  }
}

// ─── Rax 1.0 兼容 ─────────────────────────────────────────────────────────────
// Rax 在 DOM 节点上挂 `._r`(rax element);`_r._internal` 是 NativeComponent,
// 其上有一个"当前 element"字段指向 { type, props, _owner, ... },沿 `_owner`
// 可一路向上走完整 owner 链。该字段在 dev 模式叫 `__currentElement`(源码真名),
// prod 模式经常被 minify 成 `Z`,且不同打包配置可能换成其他单字符。

// 兼容 dev/prod 字段名:先查真名,再查已知 minify 名,最后扫描兜底
export function getRaxCurrentElement(compositeOrInternal: any): any | null {
  if (!compositeOrInternal || typeof compositeOrInternal !== 'object') return null;
  const dev = compositeOrInternal.__currentElement;
  if (dev) return dev;
  const prod = compositeOrInternal.Z;
  if (prod) return prod;
  for (const k of Object.getOwnPropertyNames(compositeOrInternal)) {
    const v = compositeOrInternal[k];
    if (v && typeof v === 'object' && 'type' in v && 'props' in v && '_owner' in v) {
      return v;
    }
  }
  return null;
}

export function getRaxOwnerInternal(el: Element): any | null {
  const r = (el as any)._r;
  if (!r) return null;
  return getRaxCurrentElement(r._internal)?._owner ?? null;
}

function findRaxCompositeOwner(el: Element): { owner: any; host: Element } | null {
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== document.body && depth < 10) {
    const owner = getRaxOwnerInternal(cur);
    const elObj = getRaxCurrentElement(owner);
    if (elObj) {
      const t = elObj.type;
      if (typeof t === 'function' || (t && typeof t === 'object')) {
        return { owner, host: cur };
      }
    }
    cur = cur.parentElement;
    depth++;
  }
  return null;
}

export function getRaxComponentName(owner: any): string | undefined {
  const t = getRaxCurrentElement(owner)?.type;
  if (!t) return undefined;
  if (typeof t === 'string') return t;
  if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
  if (typeof t === 'object') {
    return (
      t.displayName ||
      (t.type && (t.type.displayName || t.type.name)) ||
      (t.render && (t.render.displayName || t.render.name)) ||
      undefined
    );
  }
  return undefined;
}

// 最多向上爬几个 composite 组件层（user component）—— 用于多收集几层 props 当锚点，
// 同时通过 looksLikeListContainer 在撞到 list 容器组件之前及时刹住，避免拿到整个列表数据
const MAX_COMPONENT_LEVELS = 3;

// 判定 props 是否属于"list 容器组件"：有任一 prop 值是长度 ≥2 的对象数组
// 列表容器组件再往上的 props 会把 list 里所有 item 字段都拉进候选，对反向匹配是纯噪音
function looksLikeListContainer(props: object): boolean {
  for (const k of Object.keys(props)) {
    if (k.startsWith('_') || k === 'children') continue;
    const v = (props as any)[k];
    if (!Array.isArray(v) || v.length < 2) continue;
    let objLike = 0;
    for (let i = 0; i < Math.min(v.length, 5); i++) {
      const item = v[i];
      if (item && typeof item === 'object' && !Array.isArray(item)) objLike++;
    }
    if (objLike >= 2) return true;
  }
  return false;
}

function collectRaxCandidates(startOwner: any, el: Element): TraceCandidate[] {
  const out: TraceCandidate[] = [];
  const seen = new WeakSet<object>();

  collectElementValueCandidates(el, out);

  // 沿 owner 链向上爬：直接组件的 props 经常太薄（如 <Status text=.../> 只有 text），
  // 拿不到同 list 行的姓名/票号等唯一锚点 —— 多爬几层把它们捞进来。
  // 但碰到 list 容器组件就停（再往上 props 里是整个数组，全列表项字段都会污染候选）
  let owner = startOwner;
  let level = 0;
  while (owner && level < MAX_COMPONENT_LEVELS && out.length < MAX_CANDIDATES) {
    const curEl = getRaxCurrentElement(owner);
    const props = curEl?.props ?? owner?._instance?.props;
    if (props && typeof props === 'object') {
      if (level > 0 && looksLikeListContainer(props)) break;
      collectFromProps(props, out, [], 0, seen);
    }
    if (!curEl) break;
    owner = curEl._owner;
    level++;
  }
  return out;
}

function collectCandidates(targetFiber: any, el: Element): TraceCandidate[] {
  const out: TraceCandidate[] = [];
  const seen = new WeakSet<object>();

  // 收集元素自身的可见文本候选（textContent / input value / select option text 等）
  collectElementValueCandidates(el, out);

  // 沿 fiber 向上,host fiber 也算一层(memoizedProps 多为 { children, ... } 之类无业务字段)。
  // 收完最多 MAX_COMPONENT_LEVELS 个 user component 的 props，但碰到 list 容器组件
  // (props 里有对象数组的)就提前停 —— 再往上 list 全部 item 的字段会成噪声
  let f = targetFiber;
  let componentsCollected = 0;
  while (f && componentsCollected < MAX_COMPONENT_LEVELS && out.length < MAX_CANDIDATES) {
    const isComponent = typeof f.type === 'function' || (f.type && typeof f.type === 'object');
    if (f.memoizedProps && typeof f.memoizedProps === 'object') {
      if (componentsCollected > 0 && looksLikeListContainer(f.memoizedProps)) break;
      collectFromProps(f.memoizedProps, out, [], 0, seen);
    }
    if (isComponent) componentsCollected++;
    f = f.return;
  }

  return out;
}

function getElementSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 4) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) {
      seg = `#${CSS.escape(cur.id)}`;
      parts.unshift(seg);
      break;
    }
    const siblings = cur.parentElement
      ? Array.from(cur.parentElement.children).filter(c => c.tagName === cur!.tagName)
      : [];
    if (siblings.length > 1) {
      seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
    }
    parts.unshift(seg);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

// 过滤掉显然无意义的 className，保留可能对应组件/区块的名字
function isMeaningfulClass(c: string): boolean {
  if (!c) return false;
  if (c.length > 40) return false; // 长哈希
  if (/^_?[a-zA-Z0-9_-]{20,}$/.test(c) && !/-/.test(c)) return false; // 纯哈希片段
  if (/^css-[a-z0-9]+$/i.test(c)) return false; // emotion
  if (/^sc-[a-z0-9]+$/i.test(c)) return false; // styled-components
  // 极常见的 Tailwind/原子化工具类，过滤掉减噪
  if (
    /^(p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|w|h|gap|flex|grid|text|bg|border|rounded|shadow|opacity|cursor|select|overflow|absolute|relative|fixed|sticky|block|inline|hidden|space)-/.test(
      c,
    )
  )
    return false;
  if (/^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky)$/.test(c)) return false;
  return true;
}

// 语义选择器：只保留 id / data-testid / data-component / 有意义 class 的祖先
function getSemanticSelector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== document.body && cur !== document.documentElement && depth < 8) {
    const tag = cur.tagName.toLowerCase();
    let seg: string | null = null;

    if (cur.id) {
      seg = `${tag}#${CSS.escape(cur.id)}`;
      parts.unshift(seg);
      break; // id 是强锚点，再往上没必要
    }

    const testid =
      cur.getAttribute('data-testid') ||
      cur.getAttribute('data-component') ||
      cur.getAttribute('data-spm');
    const cls = Array.from(cur.classList).filter(isMeaningfulClass).slice(0, 2);

    if (testid) {
      seg = `${tag}[data-testid="${testid}"]`;
    } else if (cls.length) {
      seg = `${tag}.${cls.join('.')}`;
    } else if (depth === 0) {
      // 叶子节点至少保留 tag 名
      seg = tag;
    }
    // 中间没语义信息的节点直接跳过

    if (seg) parts.unshift(seg);
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

const SEMANTIC_ATTR_NAMES = new Set([
  'id',
  'role',
  'name',
  'type',
  'placeholder',
  'alt',
  'title',
  'value',
  'href',
  'src',
]);

function getSemanticAttrs(el: Element): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === 'class' || attr.name === 'style') continue;
    if (attr.name.startsWith('data-mtop-')) continue;
    if (attr.name.startsWith('on')) continue;
    const ok =
      SEMANTIC_ATTR_NAMES.has(attr.name) ||
      attr.name.startsWith('data-') ||
      attr.name.startsWith('aria-');
    if (!ok) continue;
    const v = attr.value;
    if (!v || v.length > 120) continue;
    out.push({ name: attr.name, value: v });
    if (out.length >= 8) break;
  }
  return out;
}

function emptyElementInfo() {
  return { tag: '', text: '', selector: '', semanticSelector: '', attrs: [] };
}

function emptyPageInfo() {
  return { url: location.href, pathname: location.pathname };
}

function traceElement(tagId: string, fallbackX?: number, fallbackY?: number): TraceResultPayload {
  let el = document.querySelector(`[${TRACE_ATTR}="${CSS.escape(tagId)}"]`);
  // tag 属性丢失（picker 同步 setAttribute 后、本次 querySelector 前，React 重挂了这棵子树，
  // 新节点没带属性）→ 用 picker 传来的点选坐标兜底重新定位。同位置的新节点照样有 fiber。
  if (!el && typeof fallbackX === 'number' && typeof fallbackY === 'number') {
    el = document.elementFromPoint(fallbackX, fallbackY);
  }
  if (!el) {
    return {
      ok: false,
      reason: 'element_not_found',
      candidates: [],
      elementInfo: emptyElementInfo(),
      pageInfo: emptyPageInfo(),
    };
  }

  const elementInfo = {
    tag: el.tagName.toLowerCase(),
    text: getVisibleText(el).slice(0, 80),
    selector: getElementSelector(el),
    semanticSelector: getSemanticSelector(el),
    attrs: getSemanticAttrs(el),
  };
  const pageInfo = emptyPageInfo();

  const found = getReactFiber(el);
  if (!found) {
    // 没有 React fiber,先看 Rax 1.0
    const raxFound = findRaxCompositeOwner(el);
    if (raxFound) {
      return {
        ok: true,
        reason: 'rax_no_source',
        componentName: getRaxComponentName(raxFound.owner),
        candidates: collectRaxCandidates(raxFound.owner, el),
        elementInfo,
        pageInfo,
      };
    }
    // 仍收集元素自身的文本和属性,做值匹配 —— 字段命中能拿到,只是没有组件名和源码位置
    const candidates = collectElementOnly(el);
    return {
      ok: true,
      reason: candidates.length ? 'no_react_fiber_degraded' : 'no_react_fiber',
      candidates,
      elementInfo,
      pageInfo,
    };
  }

  const { fiber } = found;
  const sourceFiber = findOwnerWithDebugSource(fiber);
  const ownerFiber = findOwnerComponent(fiber.return ?? fiber);
  const stackFiber = sourceFiber ? null : findOwnerWithDebugStack(fiber);

  let sourceLocation: SourceLocation | undefined;
  if (sourceFiber?._debugSource) {
    sourceLocation = {
      fileName: sourceFiber._debugSource.fileName,
      lineNumber: sourceFiber._debugSource.lineNumber,
      columnNumber: sourceFiber._debugSource.columnNumber,
    };
  } else if (stackFiber) {
    const ds = stackFiber._debugStack;
    const stackStr = typeof ds === 'string' ? ds : ds?.stack;
    if (stackStr) sourceLocation = parseStackForUserFrame(stackStr);
  }

  const componentName =
    getComponentName(ownerFiber) || getComponentName(sourceFiber) || getComponentName(stackFiber);

  const candidates = collectCandidates(fiber, el);

  return {
    ok: true,
    componentName,
    sourceLocation,
    candidates,
    elementInfo,
    pageInfo,
  };
}

// 仅基于 DOM 自身收集候选值（无 fiber 时的降级路径）
function collectElementOnly(el: Element): TraceCandidate[] {
  const out: TraceCandidate[] = [];
  collectElementValueCandidates(el, out);
  // 降级模式额外抓 data-* 等属性
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-mtop-')) continue;
    if (
      attr.value &&
      attr.value.length >= 2 &&
      attr.value.length <= MAX_STRING_LEN &&
      !attr.name.startsWith('on') &&
      attr.name !== 'class' &&
      attr.name !== 'style'
    ) {
      pushCandidate(out, {
        value: attr.value,
        from: 'text',
        propPath: [`@${attr.name}`],
        depth: 1,
      });
    }
  }
  return out;
}

// DOM 自身值候选：textContent / input.value / select option.text+value / textarea / img.src / a.href
function collectElementValueCandidates(el: Element, out: TraceCandidate[]): void {
  // textContent（input/textarea/select 不算）
  const isFormControl =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement;
  if (!isFormControl) {
    const text = (el.textContent || '').trim();
    if (text && text.length >= 2 && text.length <= MAX_STRING_LEN) {
      pushCandidate(out, { value: text, from: 'text', propPath: ['textContent'], depth: 0 });
    }
  }

  if (el instanceof HTMLInputElement) {
    if (el.type !== 'password' && el.type !== 'checkbox' && el.type !== 'radio' && el.value) {
      pushCandidate(out, { value: el.value, from: 'text', propPath: ['value'], depth: 0 });
    }
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.value) {
      pushCandidate(out, { value: el.value, from: 'text', propPath: ['value'], depth: 0 });
    }
  } else if (el instanceof HTMLSelectElement) {
    const opt = el.options[el.selectedIndex];
    if (opt) {
      // 用户看到的是 option.text，但接口里返回的可能是 option.value（code）；两个都收
      if (opt.text) {
        pushCandidate(out, {
          value: opt.text,
          from: 'text',
          propPath: ['selectedOption', 'text'],
          depth: 0,
        });
      }
      if (opt.value && opt.value !== opt.text) {
        pushCandidate(out, {
          value: opt.value,
          from: 'text',
          propPath: ['selectedOption', 'value'],
          depth: 0,
        });
      }
    }
  } else if (el instanceof HTMLImageElement && el.src) {
    pushCandidate(out, { value: el.src, from: 'text', propPath: ['src'], depth: 0 });
  } else if (el instanceof HTMLAnchorElement && el.href) {
    pushCandidate(out, { value: el.href, from: 'text', propPath: ['href'], depth: 0 });
  }
}

// ─── Reverse highlight: 字段 → DOM ─────────────────────────────────────────────

let highlightCleanup: (() => void) | null = null;
let highlightTimer: number | null = null;
let highlightRafId: number | null = null;

function clearReverseHighlight(): void {
  if (highlightTimer !== null) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  if (highlightRafId !== null) {
    cancelAnimationFrame(highlightRafId);
    highlightRafId = null;
  }
  if (highlightCleanup) {
    highlightCleanup();
    highlightCleanup = null;
  }
  document.getElementById(HIGHLIGHT_ID)?.remove();
}

function deepIncludesValue(obj: unknown, target: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH + 1) return false;
  if (obj === target) return true;
  if (obj == null) return false;
  if (typeof obj !== 'object') return false;
  if (obj instanceof Element || obj instanceof Node) return false;
  if (typeof (obj as any).$$typeof === 'symbol') return false;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && i < 50; i++) {
      if (deepIncludesValue(obj[i], target, depth + 1)) return true;
    }
    return false;
  }
  for (const k of Object.keys(obj as object)) {
    if (k.startsWith('_')) continue;
    if (deepIncludesValue((obj as any)[k], target, depth + 1)) return true;
  }
  return false;
}

function findElementsByValue(value: unknown): Element[] {
  const matched: Element[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let cur: Node | null = walker.currentNode;
  while (cur) {
    const el = cur as Element;
    const fiber = getReactFiberOn(el);
    if (fiber && fiber.memoizedProps) {
      if (deepIncludesValue(fiber.memoizedProps, value)) {
        matched.push(el);
        cur = walker.nextNode();
        if (matched.length >= 30) break;
        continue;
      }
    }
    // Rax 1.0: 比对 owner 链上的 props
    const raxOwner = getRaxOwnerInternal(el);
    if (raxOwner?.Z?.props && deepIncludesValue(raxOwner.Z.props, value)) {
      matched.push(el);
      cur = walker.nextNode();
      if (matched.length >= 30) break;
      continue;
    }
    // fallback: 没有 fiber/Rax 也比对 textContent
    if (typeof value === 'string' && value.length >= 3) {
      const t = (el.textContent || '').trim();
      if (t && t === value) matched.push(el);
    }
    cur = walker.nextNode();
    if (matched.length >= 30) break;
  }
  return matched;
}

function highlightElements(elements: Element[]): void {
  clearReverseHighlight();
  if (!elements.length) return;

  const container = document.createElement('div');
  container.id = HIGHLIGHT_ID;
  container.style.cssText =
    'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;transition:opacity 0.3s;';
  document.documentElement.appendChild(container);

  // 单个匹配时自动滚到视野中央
  if (elements.length === 1) {
    elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // 为每个匹配画一个边框 + 序号标签
  const items = elements.map((el, idx) => {
    const box = document.createElement('div');
    box.style.cssText = [
      'position:fixed',
      'box-sizing:border-box',
      'border:2px solid #f59e0b',
      'background:rgba(245,158,11,0.14)',
      'border-radius:2px',
      'pointer-events:none',
    ].join(';');

    let label: HTMLDivElement | null = null;
    if (elements.length > 1) {
      label = document.createElement('div');
      label.style.cssText = [
        'position:absolute',
        'background:#f59e0b',
        'color:#fff',
        'font-size:10px',
        'font-family:system-ui,sans-serif',
        'padding:1px 5px',
        'border-radius:2px',
        'pointer-events:none',
        'white-space:nowrap',
      ].join(';');
      label.textContent = `${idx + 1}/${elements.length}`;
      box.appendChild(label);
    }

    container.appendChild(box);
    return { el, box, label };
  });

  function updatePositions() {
    highlightRafId = null;
    const vw = window.innerWidth;
    for (const { el, box, label } of items) {
      const r = el.getBoundingClientRect();
      box.style.top = `${r.top}px`;
      box.style.left = `${r.left}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      if (label) {
        const labelRight = vw - r.right < 60;
        const labelBelow = r.top < 20;
        label.style.left = labelRight ? 'auto' : '0';
        label.style.right = labelRight ? '0' : 'auto';
        label.style.top = labelBelow ? 'calc(100% + 2px)' : '-18px';
      }
    }
  }

  function schedule() {
    if (highlightRafId !== null) return;
    highlightRafId = requestAnimationFrame(updatePositions);
  }

  updatePositions();
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });

  highlightCleanup = () => {
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
  };

  // 3 秒后淡出并清理（参考 SPM 高亮节奏）
  highlightTimer = window.setTimeout(() => {
    container.style.opacity = '0';
    highlightTimer = window.setTimeout(() => {
      clearReverseHighlight();
    }, 300);
  }, 3000);
}

// ─── Install ──────────────────────────────────────────────────────────────────

export function installSourceTracer(): void {
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'mearl-content') return;

    if (data.type === 'TRACE_ELEMENT') {
      const tagId: string = data.tagId;
      let result: TraceResultPayload;
      try {
        result = traceElement(tagId, data.x, data.y);
      } catch (e) {
        result = {
          ok: false,
          reason: `error:${(e as Error).message}`,
          candidates: [],
          elementInfo: emptyElementInfo(),
          pageInfo: emptyPageInfo(),
        };
      }
      // 清理标记
      const tagged = document.querySelector(`[${TRACE_ATTR}="${CSS.escape(tagId)}"]`);
      tagged?.removeAttribute(TRACE_ATTR);

      window.postMessage(
        {
          source: 'mearl-injected',
          type: 'TRACE_RESULT',
          tagId,
          payload: result,
        },
        '*',
      );
      return;
    }

    if (data.type === 'TRACE_HIGHLIGHT') {
      try {
        const matched = findElementsByValue(data.value);
        highlightElements(matched);
        window.postMessage(
          {
            source: 'mearl-injected',
            type: 'TRACE_HIGHLIGHT_RESULT',
            count: matched.length,
          },
          '*',
        );
      } catch {
        // ignore
      }
      return;
    }

    if (data.type === 'TRACE_HIGHLIGHT_CLEAR') {
      clearReverseHighlight();
    }
  });
}
