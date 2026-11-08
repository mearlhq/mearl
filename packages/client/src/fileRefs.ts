/**
 * Payload 文件引用解析（@ 前缀，仅顶层字段）
 *
 * 约定：payload 的**顶层字段**若是以 `@` 开头的字符串，`@` 之后视为文件路径，
 * 发送前会被替换为该文件内容：
 * - 默认按 JSON 解析；解析失败则按原始文本注入（适配脚本 / HTML / 纯文本 body）。
 * - **找不到 / 读不到该文件时，原样保留这个字符串**（不报错），因此 `@xxx` 这类
 *   非文件路径的普通值不会被误伤。
 *
 * 用途：把大体积字段（mock 响应体、send_request 的 body、page_eval 的 script 等）
 * 放到本地文件，调用方只传 `"@/abs/path"`，避免把整段内容塞进上下文。
 *
 * 解析在 client `invoke` 中统一执行，对所有 action 生效；路径按运行进程 cwd 解析，
 * 建议传绝对路径。仅作用于顶层字段，不递归嵌套。
 */

import fs from 'node:fs';

const FILE_REF_PREFIX = '@';

function resolveValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith(FILE_REF_PREFIX)) return value;
  const filePath = value.slice(FILE_REF_PREFIX.length);
  if (!filePath) return value;

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // 找不到 / 读不到文件：原样保留该字符串
    return value;
  }
  try {
    return JSON.parse(content);
  } catch {
    // 非 JSON 文件按原始文本注入
    return content;
  }
}

/**
 * 解析 payload 顶层字段中的 `@<path>` 文件引用。返回新对象，不修改入参。
 * 非对象入参原样返回。
 */
export function resolveFileRefs(data: Record<string, any>): Record<string, any> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = resolveValue(value);
  }
  return out;
}
