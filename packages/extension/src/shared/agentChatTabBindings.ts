export interface AgentChatTabBinding {
  ownerTabId: number;
  sessionId: string;
}

export interface AgentChatTabBindingSnapshot {
  bindings: Record<string, AgentChatTabBinding>;
}

export interface AgentChatTabRegistrationResult extends AgentChatTabBindingSnapshot {
  conflict?: AgentChatTabBinding;
}

export interface RemovedAgentChatTabBinding extends AgentChatTabBinding {
  newOwnerTabId?: number;
  tabId: number;
  remainingTabIds: number[];
}

export type DetachedAgentChatTabBinding = RemovedAgentChatTabBinding;

export interface AgentChatTabDetachmentResult extends AgentChatTabBindingSnapshot {
  detached?: DetachedAgentChatTabBinding;
}
