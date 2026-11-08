import type {
  AgentChatEventsOptions,
  AgentChatEventsResult,
  AgentChatListSessionsOptions,
  AgentChatListSessionsResult,
  AgentChatOpenWorkspaceOptions,
  AgentChatPrepareOptions,
  AgentChatRefreshResult,
  AgentChatRunOptions,
  AgentChatRunResult,
  AgentChatRespondOptions,
  AgentChatSendOptions,
  AgentChatSession,
  AgentChatSessionTarget,
  AgentChatStartOptions,
  AgentChatStatus,
} from './agentChat.js';
import type {
  AgentSkillCheckUpdatesOptions,
  AgentSkillCheckUpdatesResult,
  AgentSkillInstallOptions,
  AgentSkillInstalledListOptions,
  AgentSkillInstalledListResult,
  AgentSkillMutationOptions,
  AgentSkillMutationResult,
  AgentSkillReadOptions,
  AgentSkillReadResult,
} from './agentSkills.js';

export interface AgentServiceActionMap {
  agent_chat_pick_directory: {
    request: undefined;
    response: { path: string | null };
  };
  agent_chat_status: {
    request: undefined;
    response: AgentChatStatus;
  };
  agent_chat_install_provider: {
    request: { providerId: string };
    response: AgentChatStatus;
  };
  agent_chat_login_qoder: {
    request: undefined;
    response: { url: string | null };
  };
  agent_chat_prepare: {
    request: AgentChatPrepareOptions;
    response: { ok: true };
  };
  agent_chat_list_sessions: {
    request: AgentChatListSessionsOptions;
    response: AgentChatListSessionsResult;
  };
  agent_chat_start: {
    request: AgentChatStartOptions;
    response: AgentChatSession;
  };
  agent_chat_send: {
    request: AgentChatSendOptions;
    response: { turnId: string };
  };
  agent_chat_run: {
    request: AgentChatRunOptions;
    response: AgentChatRunResult;
  };
  agent_chat_interrupt: {
    request: AgentChatSessionTarget;
    response: { ok: true };
  };
  agent_chat_close: {
    request: AgentChatSessionTarget;
    response: { ok: true };
  };
  agent_chat_events: {
    request: AgentChatEventsOptions;
    response: AgentChatEventsResult;
  };
  agent_chat_read_visualization: {
    request: { path: string };
    response: { html: string };
  };
  agent_chat_refresh: {
    request: AgentChatEventsOptions;
    response: AgentChatRefreshResult;
  };
  agent_chat_open_app: {
    request: AgentChatSessionTarget;
    response: { ok: true };
  };
  agent_chat_open_workspace: {
    request: AgentChatOpenWorkspaceOptions;
    response: { ok: true };
  };
  agent_chat_respond: {
    request: AgentChatRespondOptions;
    response: { ok: true };
  };
  agent_skills_installed: {
    request: AgentSkillInstalledListOptions;
    response: AgentSkillInstalledListResult;
  };
  agent_skills_read: {
    request: AgentSkillReadOptions;
    response: AgentSkillReadResult;
  };
  agent_skills_install: {
    request: AgentSkillInstallOptions;
    response: AgentSkillMutationResult;
  };
  agent_skills_check_updates: {
    request: AgentSkillCheckUpdatesOptions;
    response: AgentSkillCheckUpdatesResult;
  };
  agent_skills_update: {
    request: AgentSkillMutationOptions;
    response: AgentSkillMutationResult;
  };
  agent_skills_uninstall: {
    request: AgentSkillMutationOptions;
    response: AgentSkillMutationResult;
  };
}

export type AgentServiceAction = keyof AgentServiceActionMap;

export type AgentServiceRequest<A extends AgentServiceAction> = AgentServiceActionMap[A]['request'];

export type AgentServiceResponse<A extends AgentServiceAction> =
  AgentServiceActionMap[A]['response'];

export type AgentServiceRequestArgs<A extends AgentServiceAction> =
  AgentServiceRequest<A> extends undefined ? [] : [data: AgentServiceRequest<A>];

export type AgentServiceEmptyAction = {
  [A in AgentServiceAction]: AgentServiceRequest<A> extends undefined ? A : never;
}[AgentServiceAction];

export type AgentServiceDataAction = Exclude<AgentServiceAction, AgentServiceEmptyAction>;

export type AgentServiceHandlerMap = {
  [A in AgentServiceAction]: (
    request: AgentServiceRequest<A>,
  ) => AgentServiceResponse<A> | Promise<AgentServiceResponse<A>>;
};

export const AGENT_SERVICE_ACTIONS = {
  agent_chat_pick_directory: true,
  agent_chat_status: true,
  agent_chat_install_provider: true,
  agent_chat_login_qoder: true,
  agent_chat_prepare: true,
  agent_chat_list_sessions: true,
  agent_chat_start: true,
  agent_chat_send: true,
  agent_chat_run: true,
  agent_chat_interrupt: true,
  agent_chat_close: true,
  agent_chat_events: true,
  agent_chat_read_visualization: true,
  agent_chat_refresh: true,
  agent_chat_open_app: true,
  agent_chat_open_workspace: true,
  agent_chat_respond: true,
  agent_skills_installed: true,
  agent_skills_read: true,
  agent_skills_install: true,
  agent_skills_check_updates: true,
  agent_skills_update: true,
  agent_skills_uninstall: true,
} as const satisfies Record<AgentServiceAction, true>;

export function isAgentServiceAction(value: unknown): value is AgentServiceAction {
  return typeof value === 'string' && Object.hasOwn(AGENT_SERVICE_ACTIONS, value);
}
