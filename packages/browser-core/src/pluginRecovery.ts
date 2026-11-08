export interface PluginTaskRecoveryDeclaration {
  version: 1;
  commands: Record<
    string,
    {
      checkpointVersion: number;
      schema: Record<string, unknown>;
      migrateFrom?: Array<{ version: number; schema: Record<string, unknown> }>;
    }
  >;
}

export interface PluginTaskCheckpointReference {
  sequence: number;
  version: number;
  schemaHash: string;
  updatedAt: number;
}

export interface PluginTaskCheckpoint extends PluginTaskCheckpointReference {
  data: unknown;
}

export interface PluginTaskRecoveryContext {
  fromTaskId: string;
  fromRevision: string;
  declarationHash: string;
  sourceCheckpoint: PluginTaskCheckpointReference;
  checkpoint: PluginTaskCheckpoint;
}

export interface PluginCheckpointMigrationInput {
  checkpoint: PluginTaskCheckpoint;
  fromRevision: string;
  toRevision: string;
}
