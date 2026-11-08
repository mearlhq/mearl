export type AgentSkillProviderId = string;

export type AgentSkillScope = 'project' | 'global';

export type AgentInstalledSkillScope =
  | AgentSkillScope
  | 'system'
  | 'admin'
  | 'built-in'
  | 'unknown';

export interface AgentInstalledSkill {
  name: string;
  path: string;
  scope: AgentInstalledSkillScope;
}

export interface AgentSkillUpdate {
  name: string;
  source?: string;
  scope: AgentSkillScope;
}

export interface AgentSkillInstalledListResult {
  skills: AgentInstalledSkill[];
}

export interface AgentSkillInstalledListOptions {
  providerId: AgentSkillProviderId;
  cwd?: string;
}

export interface AgentSkillReadOptions {
  providerId: AgentSkillProviderId;
  path: string;
  cwd?: string;
}

export interface AgentSkillReadResult {
  path: string;
  content: string;
}

export interface AgentSkillCheckUpdatesResult {
  updates: AgentSkillUpdate[];
}

export interface AgentSkillCheckUpdatesOptions {
  providerId: AgentSkillProviderId;
  cwd?: string;
}

export interface AgentSkillMutationOptions {
  providerId: AgentSkillProviderId;
  name: string;
  scope: AgentSkillScope;
  cwd?: string;
  /** Reject stale UI actions after a preset changes the selected manager. */
  expectedManagerId?: string;
}

export interface AgentSkillInstallOptions extends AgentSkillMutationOptions {
  source: string;
}

export interface AgentSkillMutationResult {
  ok: true;
  output: string;
}
