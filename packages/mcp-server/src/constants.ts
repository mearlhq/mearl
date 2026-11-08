import { MEARL_NATIVE_HOST_NAMES } from '@mearl/client/native-host';
/**
 * MCP Server 共享常量
 */

// 响应体大小限制
export const DEFAULT_MAX_BODY_SIZE = 50000; // 默认最大 50KB，避免传输过大数据

// MCP 响应大小阈值
export const RESPONSE_SIZE_SMALL = 50 * 1024; // 50KB - 小响应，格式化输出
export const RESPONSE_SIZE_MEDIUM = 200 * 1024; // 200KB - 中等响应，格式化+提示
export const RESPONSE_SIZE_LARGE = 500 * 1024; // 500KB - 大响应，压缩+提示
export const RESPONSE_SIZE_MAX = 1024 * 1024; // 1MB - 超大响应，截断+建议

// Native Messaging Host 配置
export const HOST_NAME = MEARL_NATIVE_HOST_NAMES.mcp;
export const DEFAULT_EXTENSION_ID = 'aoehhjnofngknnjefamjbplchbolghkm';
