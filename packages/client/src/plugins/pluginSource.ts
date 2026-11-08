import { statSync } from 'node:fs';

/** 文件替换和同大小写入都需要使缓存失效；检测只读取文件元数据。 */
export function pluginFileVersion(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`插件资源不是文件: ${path}`);
  return `${stat.dev}-${stat.ino}-${stat.mtimeMs}-${stat.ctimeMs}-${stat.size}`;
}
