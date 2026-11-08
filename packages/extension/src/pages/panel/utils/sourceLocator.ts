// 编辑器跳转 URL 构造
// MVP 默认 vscode；后续可加 settings 选项切换 cursor / webstorm / 自定义模板

interface SourceLocation {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
}

export type EditorScheme = 'vscode' | 'cursor' | 'webstorm';

const STORAGE_KEY = 'mearl-source-trace-editor';
const ROOT_KEY = 'mearl-source-trace-root';

export function getEditorScheme(): EditorScheme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'vscode' || v === 'cursor' || v === 'webstorm') return v;
  } catch {
    // ignore
  }
  return 'vscode';
}

export function setEditorScheme(scheme: EditorScheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, scheme);
  } catch {
    // ignore
  }
}

// 项目根目录绝对路径。webpack/Next.js 的 _debugStack 给的是项目相对路径
// （如 app/foo/Bar.tsx），vscode://file 需要绝对路径才能打开 —— 用它来拼前缀。
export function getProjectRoot(): string {
  try {
    return localStorage.getItem(ROOT_KEY) || '';
  } catch {
    return '';
  }
}

export function setProjectRoot(root: string): void {
  try {
    // 去掉尾部斜杠，统一由拼接处补
    localStorage.setItem(ROOT_KEY, root.trim().replace(/\/+$/, ''));
  } catch {
    // ignore
  }
}

// 绝对路径：以 / 开头（unix）或形如 C:\ / C:/（windows）
export function isAbsolutePath(file: string): boolean {
  return file.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(file);
}

// 把（可能是相对的）源码路径解析成 vscode://file 能打开的绝对路径。
// 已是绝对路径直接用；相对路径在配置了项目根目录时拼接，否则原样返回（链接打不开，但路径可见）。
export function resolveAbsoluteFile(file: string, root: string = getProjectRoot()): string {
  if (isAbsolutePath(file) || !root) return file;
  return `${root}/${file.replace(/^\.?\//, '')}`;
}

export function buildEditorUrl(
  loc: SourceLocation,
  scheme: EditorScheme = getEditorScheme(),
  root: string = getProjectRoot(),
): string {
  const file = resolveAbsoluteFile(loc.fileName, root);
  const line = loc.lineNumber;
  const col = loc.columnNumber ?? 1;
  switch (scheme) {
    case 'cursor':
      return `cursor://file/${file}:${line}:${col}`;
    case 'webstorm':
      return `webstorm://open?file=${encodeURIComponent(file)}&line=${line}&column=${col}`;
    case 'vscode':
    default:
      return `vscode://file/${file}:${line}:${col}`;
  }
}

export function formatLocation(loc: SourceLocation): string {
  const file = loc.fileName;
  // 只显示最后两段路径，避免太长
  const parts = file.split('/').filter(Boolean);
  const short = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : file;
  const col = loc.columnNumber ? `:${loc.columnNumber}` : '';
  return `${short}:${loc.lineNumber}${col}`;
}

// 把字段路径数组渲染成 a.b[0].c 形式，供卡片显示和复制
export function formatFieldPath(path: string[]): string {
  return path
    .map(seg => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`))
    .join('')
    .replace(/^\./, '');
}
