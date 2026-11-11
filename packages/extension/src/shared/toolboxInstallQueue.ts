import type { ExtensionRpcError, ToolboxPluginTool } from '@mearl/browser-core';
import type { ToolboxInstallableTool } from './toolboxCatalog';

export const TOOLBOX_INSTALL_QUEUE_PORT = 'mearl-toolbox-install-queue';

export type ToolboxInstallJob = Pick<
  ToolboxInstallableTool,
  'id' | 'plugin' | 'repository' | 'skill' | 'title'
>;

export type ToolboxInstallQueueState = {
  type: 'queue';
  installing: string | null;
  queued: string[];
};

export type ToolboxInstallQueueEvent =
  | ToolboxInstallQueueState
  | { type: 'installed'; job: ToolboxInstallJob; tools: ToolboxPluginTool[] }
  | {
      type: 'failed';
      job: ToolboxInstallJob;
      error: string;
      code: ExtensionRpcError['code'] | undefined;
      stage: 'install' | 'list';
    };
