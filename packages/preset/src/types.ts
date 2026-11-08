export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type PresetRuntime = 'browser' | 'node';

/** A child declaration patches its parent's entry with the same stable ID. */
export interface PresetComponent {
  /** Bundle URL for packages; installer-specific source for skills and providers. */
  source?: string;
  version?: string;
  /** Previous Skill sources eligible for migration only when setup owns the installation. */
  migrateFrom?: string[];
  enabled?: boolean;
  /** Optional activation subset; supported locations are defined by the package. */
  targets?: PresetRuntime[];
  dependsOn?: string[];
}

export interface PresetReference {
  source: string;
  version?: string;
}

export interface PresetManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  extends?: PresetReference;
  requires?: { mearlApi?: string };
  packages?: Record<string, PresetComponent>;
  skills?: Record<string, PresetComponent>;
  providers?: Record<string, PresetComponent>;
  appProfiles?: Record<string, string>;
  defaults?: JsonObject;
  permissions?: { origins?: string[] };
}

export type PresetComponentKind = 'packages' | 'skills' | 'providers';

export interface ResolvedComponent extends PresetComponent {
  /** Preset URL that most recently declared this entry. */
  declaredBy: string;
}

export interface ResolvedPreset {
  id: string;
  version: string;
  /** Parent-first order; every source and exact preset version is retained. */
  chain: Array<{ source: string; id: string; version: string }>;
  packages: Record<string, ResolvedComponent>;
  skills: Record<string, ResolvedComponent>;
  providers: Record<string, ResolvedComponent>;
  appProfiles: Record<string, string>;
  defaults: JsonObject;
  /** Required origins only. Actual browser grants belong to the installer. */
  permissions: { origins: string[] };
}

export interface ResolvePresetOptions {
  mearlApiVersion: string;
  /** Receives canonical absolute URLs; owns transport, credentials and source trust. */
  load(source: string): Promise<unknown>;
  signal?: AbortSignal;
}
