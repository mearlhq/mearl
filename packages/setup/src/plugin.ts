import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertPluginName,
  findPluginDirectoryEntry,
  skillManifestPath,
  readOfficialPluginCatalog,
  type PluginCatalogSelection,
  findPluginEntry,
  findPluginRegistration,
  listPluginNames,
  loadPlugin,
  OFFICIAL_PLUGIN_MANAGER,
  registerPlugin,
  resolvePluginEntry,
  unregisterPlugin,
} from '@mearl/client/plugin';
import { preserveSkillDisabled } from './skillSources.js';
import { claimPresetInstallation } from './presetInstallationLease.js';
import { ensurePluginRuntime } from './pluginRuntime.js';
import { captureSkillsCli, parseInstalledSkills, stripAnsi, type InstalledSkill } from './skills.js';
import {
  runCommand,
  withOwnedCommands,
  type CommandRunner,
} from '@mearl/daemon-core';

const registrationContext = {
  options: {},
  invoke: async () => {
    throw new Error('注册时不能执行浏览器操作');
  },
  progress: () => {
    throw new Error('注册时不能报告执行进度');
  },
};

export interface PluginSetupResult {
  entry: string;
  name: string;
}

function defaultPluginName(target: string, entry: string): string {
  const resolvedTarget = resolve(target);
  try {
    if (statSync(resolvedTarget).isDirectory()) return basename(resolvedTarget);
  } catch {
    // resolvePluginEntry 会提供具体的路径错误。
  }
  const entryDirectory = dirname(entry);
  return basename(entryDirectory) === 'scripts'
    ? basename(dirname(entryDirectory))
    : basename(entryDirectory);
}

export async function setupPlugin(
  target: string,
  requestedName?: string,
  runner: CommandRunner = runCommand,
): Promise<PluginSetupResult> {
  if (requestedName) assertPluginName(requestedName);
  const entry = resolvePluginEntry(target);
  const plugin = await loadPlugin(entry, registrationContext);
  const name = requestedName || plugin.name || defaultPluginName(target, entry);
  assertPluginName(name);
  await ensurePluginRuntime(runner);
  await plugin.setup?.({ runCommand: runner });
  return {
    entry: registerPlugin(name, entry, plugin.description, {
      hasPublicCommands: Boolean(plugin.commandHelp(name)),
      toolbox: plugin.toolbox,
      appProfiles: plugin.appProfiles,
      profileSources: plugin.profileSources,
    }),
    name,
  };
}

export async function ensureOfficialPlugin(
  name: string,
  runner: CommandRunner = runCommand,
): Promise<'existing' | 'installed'> {
  const accepted = readOfficialPluginCatalog();
  const definition = accepted?.plugins[name];
  if (!definition) throw new Error(`未知官方插件: ${name}`);
  const existing = findPluginRegistration(name);
  if (existing) {
    if (!accepted.selection || existing.managedBy !== OFFICIAL_PLUGIN_MANAGER) return 'existing';
    const cli = await captureSkillsCli({ runCommand: runner });
    if (!cli || cli.selection?.path !== accepted.selection.path || cli.selection.sha256 !== accepted.selection.sha256) throw new Error('PLUGIN_CATALOG_SELECTION_CHANGED');
    const declaration = cli.managedSkills[definition.skill];
    if (!declaration?.source || declaration.source !== definition.installArgs[0]) throw new Error('PLUGIN_CATALOG_SKILL_UNDECLARED');
    const status = cli.inspectGlobal(declaration.source, definition.skill, declaration.version, { migrateFrom: declaration.migrateFrom });
    if (status.state === 'ready') return 'existing';
    if (status.state === 'conflict') throw new Error(`${status.reason}: ${definition.skill}`);
  }
  const lease = claimPresetInstallation();
  try {
    return await withOwnedCommands(lease.lifecycle, async () => {
      const code = await installPlugins([...definition.installArgs], runner, {
        registrationManagedBy: OFFICIAL_PLUGIN_MANAGER,
        selection: accepted.selection,
        ...(accepted.selection ? { expectedSkill: definition.skill, expectedPluginName: name } : {}),
        confirm: () => { if (JSON.stringify(readOfficialPluginCatalog()) !== JSON.stringify(accepted)) throw new Error('PLUGIN_CATALOG_SELECTION_CHANGED'); },
      });
      if (code !== 0) throw new Error(`官方插件 ${name} 安装失败 (exit ${code})`);
      const registration = findPluginRegistration(name);
      if (!registration) throw new Error(`官方插件 ${name} 安装完成后仍未注册`);
      return 'installed' as const;
    });
  } finally { lease.release(); }
}

export interface PluginUninstallResult {
  entryMissing?: boolean;
  removed: boolean;
  skillName?: string;
  unregisteredNames: string[];
}

interface SkillLocation {
  directory: string;
  name: string;
  cwd?: string;
}

function globalSkill(entry: string): SkillLocation | undefined {
  const globalSkillsDirectory = join(homedir(), '.agents', 'skills');
  const relativeEntry = relative(globalSkillsDirectory, resolve(entry));
  if (
    !isAbsolute(relativeEntry) &&
    relativeEntry !== '..' &&
    !relativeEntry.startsWith(`..${sep}`)
  ) {
    const [name, ...entrySegments] = relativeEntry.split(sep);
    if (name && entrySegments.length > 0)
      return { directory: join(globalSkillsDirectory, name), name };
  }

  const sourceDirectory = dirname(dirname(resolve(entry)));
  if (basename(dirname(entry)) !== 'scripts') return undefined;
  try {
    const source = existsSync(sourceDirectory) ? realpathSync(sourceDirectory) : sourceDirectory;
    for (const name of readdirSync(globalSkillsDirectory)) {
      const directory = join(globalSkillsDirectory, name);
      let target: string;
      try {
        target = resolve(globalSkillsDirectory, readlinkSync(directory));
      } catch {
        continue;
      }
      if (target === sourceDirectory || (existsSync(target) && realpathSync(target) === source)) {
        return { directory, name };
      }
    }
  } catch {
    // 全局 Skill 目录不可读时保留本地插件的普通卸载路径。
  }
  return undefined;
}

function projectSkill(entry: string, managedBy?: string): SkillLocation | undefined {
  if (!managedBy) return undefined;
  const absolute = resolve(entry);
  const marker = `${sep}.agents${sep}skills${sep}`;
  const markerIndex = absolute.lastIndexOf(marker);
  if (markerIndex <= 0) return undefined;
  const cwd = absolute.slice(0, markerIndex);
  if (resolve(cwd) === resolve(homedir())) return undefined;
  const [name, scripts, filename, ...remaining] = absolute
    .slice(markerIndex + marker.length)
    .split(sep);
  if (
    !name ||
    scripts !== 'scripts' ||
    !['main.mjs', 'main.py'].includes(filename) ||
    remaining.length > 0
  )
    return undefined;
  return { directory: join(cwd, '.agents', 'skills', name), name, cwd };
}

export async function uninstallPlugin(
  name: string,
  runner: CommandRunner = runCommand,
  options: { preserveRegistrationsOutsideManager?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PluginUninstallResult> {
  assertPluginName(name);
  const entry = findPluginEntry(name);
  if (!entry) return { removed: false, unregisteredNames: [] };

  const entryMissing = !existsSync(entry);
  const managedSkill =
    projectSkill(entry, findPluginRegistration(name)?.managedBy) ?? globalSkill(entry);
  if (!managedSkill) {
    unregisterPlugin(name);
    return {
      ...(entryMissing ? { entryMissing: true } : {}),
      removed: true,
      unregisteredNames: [name],
    };
  }

  const { directory: skillDirectory, name: skillName } = managedSkill;
  const unregisteredNames = listPluginNames().filter(pluginName => {
    try {
      const candidate = findPluginEntry(pluginName);
      if (!candidate) return false;
      const candidateSkill = projectSkill(candidate, 'skills') ?? globalSkill(candidate);
      return candidateSkill?.directory === skillDirectory;
    } catch {
      return false;
    }
  });
  if (options.preserveRegistrationsOutsideManager && unregisteredNames.some(pluginName =>
    findPluginRegistration(pluginName)?.managedBy !== options.preserveRegistrationsOutsideManager,
  )) {
    unregisterPlugin(name);
    return { removed: true, unregisteredNames: [name] };
  }
  const cli = await captureSkillsCli({ env: options.env, runCommand: runner });
  if (!cli) throw new Error('未找到 skills 或 npx，插件注册已保留。');
  let placeholderCreated = false;
  if (!existsSync(skillDirectory)) {
    mkdirSync(dirname(skillDirectory), { recursive: true, mode: 0o700 });
    try {
      mkdirSync(skillDirectory, { mode: 0o700 });
      placeholderCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  let removed: Awaited<ReturnType<CommandRunner>>;
  try {
    removed = await cli.run(
      [
        'remove',
        skillName,
        ...(managedSkill.cwd ? [] : ['--global']),
        '--yes',
      ],
      { tee: true, ...(managedSkill.cwd ? { cwd: managedSkill.cwd } : {}) },
    );
  } catch (error) {
    throw new Error(
      `skills remove ${skillName} 执行失败：${error instanceof Error ? error.message : String(error)}；插件注册已保留。`,
      { cause: error },
    );
  } finally {
    if (placeholderCreated) {
      try {
        rmdirSync(skillDirectory);
      } catch {
        /* skills 已移除，或目录中出现了新内容。 */
      }
    }
  }
  if (removed.code !== 0) {
    throw new Error(
      `skills remove ${skillName} 失败（exit ${removed.code}）；插件注册已保留。`,
    );
  }

  if (/Failed to remove\s+[1-9]\d*\s+skills?/i.test(stripAnsi(`${removed.stdout}\n${removed.stderr}`)) || existsSync(skillDirectory)) {
    throw new Error(`skills remove ${skillName} 未完成；插件注册已保留。`);
  }

  for (const pluginName of unregisteredNames) unregisterPlugin(pluginName);
  return {
    ...(entryMissing ? { entryMissing: true } : {}),
    removed: true,
    skillName,
    unregisteredNames,
  };
}

/** Skills 的 Installed 区块列出成功路径；计数校验避免输出变化导致漏注册。 */
export function parseInstalledPluginPaths(output: string, listed: InstalledSkill[] = []): string[] {
  const paths: string[] = [];
  let expected = 0;
  let inResult = false;
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const heading = line.match(/\bInstalled (\d+) skills?\b/);
    if (heading) {
      expected += Number(heading[1]);
      inResult = true;
      continue;
    }
    if (!inResult) continue;
    if (/[╰└├]/.test(line)) {
      inResult = false;
      continue;
    }
    const item = line.trim().match(/^[│|]?\s*✓\s+(.+?)\s*[│|]?$/);
    if (!item) continue;
    const value = item[1].trim().replaceAll('\\', '/');
    const copied = value.match(/^(.+?) \(copied\)$/);
    const matches = copied ? listed.filter(skill => skill.scope === 'global' && skill.name === copied[1]) : [];
    if (copied && matches.length !== 1) throw new Error('无法从 Skills JSON 清单确认复制的 Skill 安装路径。');
    const installedPath = copied ? matches[0].path : value;
    const skillPath = resolve(installedPath.startsWith('~/') ? join(homedir(), installedPath.slice(2)) : installedPath);
    if (dirname(skillPath) !== join(homedir(), '.agents', 'skills')) {
      throw new Error(
        `无法识别全局 skill 安装路径: ${item[1]}。请使用 setup plugin [name] <path> 注册。`,
      );
    }
    paths.push(skillPath);
  }
  if (paths.length !== expected)
    throw new Error('Skills 安装结果格式无法识别，请使用 setup plugin [name] <path> 注册。');
  return [...new Set(paths)];
}

function permitsEmptyInstallResult(args: string[], output: string): boolean {
  return (
    args.length === 0 ||
    args.some(argument => ['--help', '-h', '--list'].includes(argument)) ||
    /\b(?:installation\s+)?cancel(?:led|ed)\b/i.test(output)
  );
}

export async function installPlugins(
  args: string[],
  runner: CommandRunner = runCommand,
  options: { registrationManagedBy?: string; env?: NodeJS.ProcessEnv; selection?: PluginCatalogSelection; expectedSkill?: string; expectedPluginName?: string; confirm?: () => void | Promise<void> } = {},
): Promise<number> {
  if (args.includes('--')) {
    throw new Error('plugin install 不支持 -- 参数分隔符，以确保全局安装选项生效。');
  }
  const cli = await captureSkillsCli({ env: options.env, runCommand: runner });
  if (!cli) throw new Error('未找到 skills 或 npx，请检查 Node.js 安装。');
  if (options.selection && (cli.selection?.path !== options.selection.path || cli.selection.sha256 !== options.selection.sha256)) throw new Error('PLUGIN_CATALOG_SELECTION_CHANGED');
  const declaration = options.expectedSkill ? cli.managedSkills[options.expectedSkill] : undefined;
  if (options.expectedSkill && (!declaration?.source || declaration.source !== args[0])) throw new Error('PLUGIN_CATALOG_SKILL_UNDECLARED');
  const verifySkill = (registered = false) => {
    if (!options.expectedSkill || !declaration) return;
    const status = cli.inspectGlobal(declaration.source!, options.expectedSkill, declaration.version);
    if (status.state !== 'ready' && (registered || status.state !== 'registration')) throw new Error(`${status.reason}: ${options.expectedSkill}`);
  };
  const assertSource = () => {
    if (!options.expectedSkill || !declaration) return;
    const status = cli.inspectGlobal(declaration.source!, options.expectedSkill, declaration.version, {
      migrateFrom: options.registrationManagedBy === OFFICIAL_PLUGIN_MANAGER ? declaration.migrateFrom : undefined,
    });
    if (status.state === 'conflict') throw new Error(`${status.reason}: ${options.expectedSkill}`);
  };
  assertSource();
  await options.confirm?.();
  assertSource();
  const runInstall = () => cli.run(['add', ...args, '--global'], { tee: true });
  const installed = await (options.expectedSkill
    ? preserveSkillDisabled(join(homedir(), '.agents', 'skills', options.expectedSkill), runInstall)
    : runInstall());
  if (installed.code !== 0) return installed.code;
  await options.confirm?.();
  const output = `${installed.stdout ?? ''}\n${installed.stderr ?? ''}`;
  let listed: InstalledSkill[] = [];
  if (/✓[^\n]*\(copied\)/.test(stripAnsi(output))) {
    const result = await cli.run(['list', '--global', '--json'], { capture: true });
    if (result.code !== 0) throw new Error('无法读取 Skills JSON 清单；插件尚未注册。');
    listed = parseInstalledSkills(result.stdout);
  }
  const paths = parseInstalledPluginPaths(output, listed);
  if (options.expectedSkill) {
    if (paths.length !== 1 || paths[0] !== join(homedir(), '.agents', 'skills', options.expectedSkill)) throw new Error('PLUGIN_CATALOG_SKILL_RESULT_MISMATCH');
    verifySkill();
  }
  if (paths.length === 0) {
    if (permitsEmptyInstallResult(args, output)) return 0;
    throw new Error(
      'Skills 安装成功但无法识别安装结果，请使用 setup plugin [name] <path> 注册。',
    );
  }

  const plugins = new Map<
    string,
    {
      description?: string;
      entry: string;
      hasPublicCommands: boolean;
      toolbox?: Awaited<ReturnType<typeof loadPlugin>>['toolbox'];
      appProfiles?: Awaited<ReturnType<typeof loadPlugin>>['appProfiles'];
      profileSources?: Record<string, string>;
      setup?: Awaited<ReturnType<typeof loadPlugin>>['setup'];
    }
  >();
  for (const skillPath of paths) {
    if (!statSync(skillManifestPath(skillPath) ?? join(skillPath, 'SKILL.md')).isFile())
      throw new Error(`安装结果缺少 SKILL.md: ${skillPath}`);
    const entry = findPluginDirectoryEntry(skillPath);
    if (!entry) continue;
    const plugin = await loadPlugin(entry, registrationContext);
    const name = plugin.name || basename(skillPath);
    assertPluginName(name);
    if (options.expectedPluginName && name !== options.expectedPluginName) throw new Error('PLUGIN_CATALOG_ALIAS_MISMATCH');
    if (plugins.has(name))
      throw new Error(`多个 skill 使用插件名称 ${name}，请调整入口的 name metadata。`);
    plugins.set(name, {
      entry,
      setup: plugin.setup,
      hasPublicCommands: Boolean(plugin.commandHelp(name)),
      description: plugin.description,
      ...(plugin.toolbox ? { toolbox: plugin.toolbox } : {}),
      appProfiles: plugin.appProfiles,
      profileSources: plugin.profileSources,
    });
  }
  if (plugins.size === 0) {
    console.error(
      '未找到 scripts/main.mjs 或 scripts/main.py 插件入口；自定义入口可用 setup plugin [name] <path> 注册。',
    );
    return 0;
  }
  await ensurePluginRuntime(runner);
  for (const [
    name,
    { entry, description, toolbox, appProfiles, profileSources, hasPublicCommands, setup },
  ] of plugins) {
    await options.confirm?.();
    verifySkill();
    const hasUserRegistration = () => {
      const existing = findPluginRegistration(name);
      return options.registrationManagedBy && existing && existing.managedBy !== options.registrationManagedBy;
    };
    if (hasUserRegistration()) {
      console.error(`Plugin ${name}: existing user registration kept.`);
      continue;
    }
    if (setup) {
      await setup({ runCommand: runner });
      await options.confirm?.();
      verifySkill();
      if (hasUserRegistration()) {
        console.error(`Plugin ${name}: existing user registration kept.`);
        continue;
      }
    }
    registerPlugin(name, entry, description, {
      hasPublicCommands,
      managedBy: options.registrationManagedBy ?? (cli.id === 'skills' ? undefined : cli.id),
      ...(toolbox ? { toolbox } : {}),
      appProfiles,
      profileSources,
    });
    console.error(
      `Plugin ${name} registered: ${entry}${hasPublicCommands ? `\nRun: mearl ${name} --help` : toolbox ? '\nOpen in Mearl toolbox.' : ''}`,
    );
  }
  verifySkill(true);
  return 0;
}
