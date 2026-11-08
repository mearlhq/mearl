export {};

declare namespace chrome.declarativeNetRequest {
  interface RuleMatchedDebugDetails {
    request: {
      tabId: number;
      url: string;
      method: string;
      frameId: number;
      parentFrameId: number;
      requestId: string;
      type: ResourceType;
    };
    rule: {
      ruleId: number;
      rulesetId: string;
    };
  }

  const onRuleMatchedDebug: {
    addListener(callback: (details: RuleMatchedDebugDetails) => void): void;
    removeListener(callback: (details: RuleMatchedDebugDetails) => void): void;
    hasListener(callback: (details: RuleMatchedDebugDetails) => void): boolean;
  };
}

declare global {
  interface Window {
    chrome: typeof chrome;
    // early-inject（MAIN world）防重复注入标记
    __mearlEarlyInjected?: boolean;
    __mearlElementPickerMainRuntime?: boolean;
    __MEARL_OVERRIDE_ENABLED__?: boolean;
    __MEARL_AGENT_CHAT_ALLOW_NEW_TABS__?: boolean;
    __mearlConfig?: {
      language: string;
      sseMonitoringEnabled: boolean;
    };
    __mearl_collectElement?: (el: Element | null, includeOuterHTML?: boolean) => unknown;
  }
}

declare global {
  namespace chrome.permissions {
    interface PermissionsRemovedEvent {
      removeListener(callback: (permissions: Permissions) => void): void;
    }
  }
}
