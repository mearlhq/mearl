import path from 'node:path';
import { SETUP_VERSION } from './setupVersion.js';
import { homedir } from 'node:os';
import { NodeCapabilityRegistry } from '@mearl/daemon-core/capabilities';
import { inspectGlobalSkill, readTrackedSkillSources } from './skillSources.js';
import type { PluginCatalogSelection } from '@mearl/client/plugin';
import type { ResolvedComponent } from '@mearl/preset';
import { PresetInstallationStore } from './presetStore.js';
import {
  findExecutable,
  isExecutable,
  npmExecEnvironment,
  prependCommandPath,
  prependNodePath,
  runCommand,
  type CommandRunner,
  type CommandResult,
  type RunCommandOptions,
} from '@mearl/daemon-core';

export const SKILLS_CLI_PACKAGE = 'skills@1.5.0';
export const MEARL_SKILL_SOURCE = SETUP_VERSION.includes('-beta.')
  ? `https://github.com/mearlhq/mearl/tree/v${SETUP_VERSION}`
  : 'https://github.com/mearlhq/mearl';
const COMMAND_TIMEOUT_MS = 120_000;
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'g');

export interface ResolveSkillsOptions {
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  platform?: NodeJS.Platform;
  processExecPath?: string;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}

export function resolveSkillsExecutable(options: ResolveSkillsOptions = {}): string | null {
  const candidate = (options.env ?? process.env).MEARL_SKILLS_PATH;
  const exists = options.existsSync ?? (file => isExecutable(file, options.platform ?? process.platform));
  return candidate && exists(candidate) ? candidate : null;
}

interface SkillsInvocation {
  command: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
}

export function resolveSkillsInvocation(
  options: ResolveSkillsOptions = {},
): SkillsInvocation | null {
  const env = options.env ?? process.env;
  const executable = resolveSkillsExecutable(options);
  if (executable) {
    return {
      command: executable,
      argsPrefix: [],
      env: prependNodePath(prependCommandPath(executable, env)),
    };
  }

  const processExecPath = options.processExecPath ?? process.execPath;
  const npx = findExecutable('npx', {
    env,
    existsSync: options.existsSync,
    platform: options.platform,
    extraDirectories: [path.dirname(processExecPath)],
  });
  if (!npx) return null;
  return {
    command: npx,
    argsPrefix: ['-y', SKILLS_CLI_PACKAGE],
    env: npmExecEnvironment(prependNodePath(prependCommandPath(npx, env), processExecPath)),
  };
}

export interface SkillsCli {
  id: string;
  managedSkills: Readonly<Record<string, ResolvedComponent>>;
  selection?: PluginCatalogSelection;
  inspectGlobal: typeof inspectGlobalSkill;
  run(args: string[], options?: Pick<RunCommandOptions, 'capture' | 'tee' | 'cwd' | 'timeoutMs'>): Promise<CommandResult>;
}

/** Only the selected manager module is needed; browser and Provider factories stay in their hosts. */
export async function captureSkillsCli(options: ResolveSkillsOptions & { runCommand?: CommandRunner } = {}): Promise<SkillsCli | undefined> {
  const env = options.env ?? process.env;
  const runner = options.runCommand ?? runCommand;
  const directory = env.MEARL_CAPABILITY_DIR || path.join(homedir(), '.mearl', 'capabilities');
  const current = await new PresetInstallationStore({ directory }).current({ verifyResources: false });
  const registry = new NodeCapabilityRegistry({ env: Object.freeze({ ...env }), runCommand: runner }, directory, { hooks: ['skills.manager'] });
  await registry.refresh();
  if (current.activation?.revision !== registry.revision || current.activation?.installationRevision !== registry.installationRevision) throw new Error('SKILL_MANAGER_CHANGED');
  const readSources: typeof readTrackedSkillSources = (scope, cwd) => readTrackedSkillSources(scope, cwd, { env });
  const selection = current.rawHash ? { path: path.resolve(directory, 'active-node.json'), sha256: current.rawHash } : undefined;
  const managedSkills = Object.fromEntries(Object.entries(current.preset?.skills ?? {}).filter(([, entry]) => entry.enabled !== false));
  const backend = registry.get<() => { id: string; cli?: SkillsCli['run']; normalizeSource?: (source: string, sourceType?: string) => string; readSources?: typeof readTrackedSkillSources } | undefined>('skills.manager')?.();
  if (backend !== undefined) {
    if (backend?.readSources !== undefined && typeof backend.readSources !== 'function') throw new Error('Invalid Skill source reader');
    if (!backend || typeof backend.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(backend.id) || typeof backend.cli !== 'function') throw new Error('The selected Skill manager requires a preset update for CLI operations');
    return { id: backend.id, managedSkills, selection, inspectGlobal: (source, name, version, inspection) => inspectGlobalSkill(source, name, version, { migrateFrom: inspection?.migrateFrom, externalManager: true, normalizeSource: backend.normalizeSource, readSources: backend.readSources ?? readSources }), run: async (args, settings) => {
      const result = await backend.cli!([...args], settings);
      if (!result || !Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error('Invalid Skill manager CLI result');
      return result;
    } };
  }
  const invocation = resolveSkillsInvocation(options);
  if (!invocation) return undefined;
  return { id: 'skills', managedSkills, selection, inspectGlobal: (source, name, version, inspection) => inspectGlobalSkill(source, name, version, { migrateFrom: inspection?.migrateFrom, readSources }), run: (args, settings) => runner(invocation.command, [...invocation.argsPrefix, ...args], { ...settings, env: invocation.env }) };
}

export interface InstalledSkill {
  name: string;
  path: string;
  scope: 'global' | 'project';
}

export function parseInstalledSkills(output: string): InstalledSkill[] {
  const value: unknown = JSON.parse(stripAnsi(output).trim());
  if (!Array.isArray(value) || value.some(item => !item || typeof item.name !== 'string' || typeof item.path !== 'string' || !['global', 'project'].includes(item.scope))) throw new Error('Skills returned an invalid skill list');
  return value;
}

export function parseGlobalMearlSkillPaths(output: string): string[] {
  const parsed = parseInstalledSkills(output);
  return [
    ...new Set(
      parsed.flatMap((skill: InstalledSkill) =>
        skill.name === 'mearl' &&
        skill.scope === 'global' &&
        typeof skill.path === 'string' &&
        skill.path.trim()
          ? [skill.path.trim()]
          : [],
      ),
    ),
  ];
}

export type MearlSkillOperation = 'install' | 'update' | 'uninstall';

export async function runGlobalMearlSkillOperation(
  operation: MearlSkillOperation,
  options: ResolveSkillsOptions & {
    runCommand?: CommandRunner;
    yes?: boolean;
    writeLine?: (line: string) => void;
  } = {},
): Promise<boolean> {
  const runner = options.runCommand ?? runCommand;
  const writeLine = options.writeLine ?? (line => console.error(line));
  let cli: SkillsCli | undefined;
  try { cli = await captureSkillsCli({ ...options, runCommand: runner }); }
  catch (error) { writeLine(`Skill: ${error instanceof Error ? error.message : String(error)}`); return false; }
  if (!cli) {
    writeLine('Skill: skills and npx are both unavailable.');
    return false;
  }

  if (operation !== 'uninstall' && cli.managedSkills.mearl) {
    const owned = cli.managedSkills.mearl;
    let status: ReturnType<typeof inspectGlobalSkill>;
    try { status = cli.inspectGlobal(owned.source!, 'mearl', owned.version); }
    catch (error) { writeLine(`Skill: ${error instanceof Error ? error.message : String(error)}`); return false; }
    if (status.state !== 'ready') { writeLine(`Skill: preset-managed Mearl requires preset apply/update (${status.reason}).`); return false; }
    writeLine('Skill: retained the Mearl Skill managed by the selected preset.');
    return true;
  }
  const run = async (args: string[], capture: boolean) => {
    try {
      return await cli.run(args, {
        capture,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      writeLine(`Skill: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const listMearlPaths = async (): Promise<string[] | null> => {
    const listed = await run(['list', '--global', '--json'], true);
    if (!listed) return null;
    if (listed.code !== 0) {
      writeLine(`Skill: unable to list global skills (exit ${listed.code}).`);
      const detail = stripAnsi(listed.stderr || listed.stdout).trim();
      if (detail) writeLine(detail);
      return null;
    }
    try {
      return parseGlobalMearlSkillPaths(listed.stdout);
    } catch (error) {
      writeLine(`Skill: ${error instanceof Error ? error.message : String(error)}.`);
      return null;
    }
  };
  if (operation === 'install') {
    const installed = await run(
      [
        'add',
        MEARL_SKILL_SOURCE,
        '--skill',
        'mearl',
        '--global',
        ...(options.yes ? ['--yes'] : []),
      ],
      false,
    );
    if (!installed) return false;
    if (installed.code !== 0) {
      writeLine(`Skill: install failed (exit ${installed.code}).`);
      return false;
    }
    const installedPaths = await listMearlPaths();
    if (!installedPaths || installedPaths.length === 0) {
      writeLine('Skill: installation finished without a tracked global mearl skill.');
      return false;
    }
    writeLine('Skill: installed.');
    return true;
  }

  const paths = await listMearlPaths();
  if (!paths) return false;
  if (paths.length === 0) {
    writeLine('Skill: no tracked global mearl skill found; skipped.');
    return true;
  }

  writeLine('Skill installation:');
  paths.forEach(skillPath => writeLine(`  ${skillPath}`));
  const args =
    operation === 'update'
      ? ['add', MEARL_SKILL_SOURCE, '--skill', 'mearl', '--global', '--yes']
      : ['remove', 'mearl', '--global', '--yes'];
  const result = await run(args, true);
  if (!result) return false;
  if (result.code !== 0) {
    writeLine(`Skill: ${operation} failed (exit ${result.code}).`);
    return false;
  }
  const detail = stripAnsi(`${result.stdout}
${result.stderr}`).trim();
  if (detail) writeLine(detail);
  if (/Failed to (?:update|remove)\s+[1-9]\d*\s+skills?/i.test(detail) || (operation === 'update' && !/\bInstalled [1-9]\d* skills?\b/.test(detail))) {
    writeLine(`Skill: ${operation} failed.`);
    return false;
  }
  const remainingPaths = await listMearlPaths();
  if (!remainingPaths || (operation === 'uninstall' ? remainingPaths.length !== 0 : remainingPaths.length === 0)) {
    writeLine(`Skill: ${operation} did not reach the expected installation state.`);
    return false;
  }
  writeLine(`Skill: ${operation === 'update' ? 'updated' : 'uninstalled'}.`);
  return true;
}
