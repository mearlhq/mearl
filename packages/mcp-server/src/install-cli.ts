#!/usr/bin/env node

/**
 * mearl-mcp-install - 用户友好的安装命令
 *
 * 使用方式：
 *   mearl-mcp-install
 *   MEARL_EXTENSION_ID=xxx mearl-mcp-install
 */

import { installNativeHost } from '@mearl/native-host';

console.log('🚀 Mearl MCP Installer\n');

const extensionId = process.env.MEARL_EXTENSION_ID;

// Install both host manifests so MCP and Skills integrations can coexist.
const success = await installNativeHost({
  mode: 'both',
  ...(extensionId ? { extensionId } : {}),
});

process.exit(success ? 0 : 1);
