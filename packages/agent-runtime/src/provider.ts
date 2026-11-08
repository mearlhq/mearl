import type { AgentInstalledSkill } from '@mearl/browser-core/agentSkills';
import type {
  AgentChatEventKind,
  AgentChatImageInput,
  AgentChatListSessionsOptions,
  AgentChatModelInfo,
  AgentChatProviderDescriptor,
  AgentChatRunOptions,
  AgentChatSessionSummary,
} from '@mearl/browser-core/agentChat';

export interface AgentProviderEvent {
  providerSessionId?: string;
  kind: AgentChatEventKind;
  method: string;
  params: unknown;
  timestamp?: number;
  requestId?: string | number;
}

export interface AgentProviderSessionOptions {
  cwd?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  readOnly?: boolean;
  modelExecution?: boolean;
  modelId?: string;
}

export interface AgentProviderTurnOptions {
  reasoningEffort?: AgentChatRunOptions['reasoningEffort'];
  reasoningSummary?: 'none' | 'detailed';
  outputSchema?: Record<string, unknown>;
  modelExecution?: boolean;
}

export type AgentProviderSessionSummary = Omit<AgentChatSessionSummary, 'providerId'>;

export interface AgentProviderListSessionsOptions extends Omit<
  AgentChatListSessionsOptions,
  'providerId' | 'limit'
> {
  limit: number;
}

export interface AgentProviderListSessionsResult {
  sessions: AgentProviderSessionSummary[];
  nextCursor?: string;
}

export interface AgentProviderResumeResult {
  providerSessionId: string;
  history?: AgentProviderEvent[];
  historyComplete?: boolean;
}

export interface AgentProvider {
  readonly id: string;
  getDescriptor(): Promise<AgentChatProviderDescriptor>;
  prepare(): Promise<void>;
  onEvent(listener: (event: AgentProviderEvent) => void): () => void;
  listSessions?(
    options: AgentProviderListSessionsOptions,
  ): Promise<AgentProviderListSessionsResult>;
  listSkills?(cwd?: string): Promise<AgentInstalledSkill[]>;
  startSession(options: AgentProviderSessionOptions): Promise<string>;
  resumeSession(
    providerSessionId: string,
    options: AgentProviderSessionOptions,
  ): Promise<AgentProviderResumeResult>;
  getSessionModel?(providerSessionId: string): AgentChatModelInfo | undefined;
  validateMessageInput?(images: AgentChatImageInput[]): Promise<void>;
  sendMessage(
    providerSessionId: string,
    message: string,
    images?: AgentChatImageInput[],
    options?: AgentProviderTurnOptions,
  ): Promise<{ turnId: string }>;
  interrupt(providerSessionId: string, turnId: string): Promise<void>;
  closeSession(providerSessionId: string): Promise<void>;
  openSession?(providerSessionId: string): Promise<void>;
  openWorkspace?(cwd: string): Promise<void>;
  respondToRequest(requestId: string | number, result: unknown): void;
  dispose(): void;
}
