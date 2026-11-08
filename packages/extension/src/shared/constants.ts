export const DEFAULT_EXTENSION_ID = 'aoehhjnofngknnjefamjbplchbolghkm';
export const AGENT_INTEGRATION_MODE_STORAGE_KEY = 'mearl-integration-mode';
export const MEARL_DOC_URL = 'https://github.com/mearlhq/mearl';

// Server-Timing header keys — used by DNR rules (background) and early-inject (content-script)
// to synchronously pass configuration flags via navigation response headers.
//
// Two channels：
// - CONFIG: 全局 SSE 配置，desc 为 base64(JSON)。JSON 结构：{ sse?: boolean }
// - COLLECT: 仅对特定 tabIds 生效的 Agent 采集模式标记，值恒为 "1"。
export const CONFIG_SERVER_TIMING_KEY = 'mearl-config';
export const COLLECT_SERVER_TIMING_KEY = 'mearl-collect';
export const AGENT_CHAT_ALLOW_NEW_TABS_SERVER_TIMING_KEY = 'mearl-agent-chat-tabs';
export const SETTINGS_CONTEXT_TAB_STORAGE_KEY = 'settingsContextTabIdV1';
