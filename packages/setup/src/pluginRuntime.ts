import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  buildGlobalPackageCommand,
  detectCliPackage,
  detectGlobalPackage,
  resolveInvokingPackageManager,
} from './packageManager.js';
import { prependCommandPath, runCommand, type CommandRunner } from '@mearl/daemon-core';
import { compareMearlReleaseVersions, isMearlReleaseVersion } from './version.js';
import { packageRegistryEnvironment } from './npmRegistry.js';

const require = createRequire(import.meta.url);
export const PLUGIN_RUNTIME_VERSION: string = require('../package.json').version;

/** 插件使用当前 setup 同版本的运行时；已安装的更高版本保持不动。 */
export async function ensurePluginRuntime(runner: CommandRunner = runCommand): Promise<void> {
  for (const [packageName, bin] of [
    ['@mearl/client', 'mearl'],
    ['@mearl/native-host', 'mearl-native-host'],
  ]) {
    const inspect = () => {
      const installed = detectCliPackage(packageName, [bin]);
      const manifest =
        installed && JSON.parse(readFileSync(join(installed.packageRoot, 'package.json'), 'utf8'));
      const version = manifest?.version;
      const pluginExport = manifest?.exports?.['./plugin']?.import;
      const supported =
        packageName !== '@mearl/client' ||
        (installed &&
          typeof pluginExport === 'string' &&
          existsSync(join(installed.packageRoot, pluginExport)));
      const current =
        isMearlReleaseVersion(version) &&
        compareMearlReleaseVersions(version, PLUGIN_RUNTIME_VERSION) >= 0;
      return { installed, version, current, ready: current && supported };
    };
    const before = inspect();
    let ready = before;
    if (!before.ready) {
      if (
        before.current &&
        compareMearlReleaseVersions(before.version, PLUGIN_RUNTIME_VERSION) > 0
      ) {
        throw new Error(
          `${packageName}@${before.version} 缺少插件入口，请修复该版本的安装后重试。`,
        );
      }
      const manager = detectGlobalPackage(packageName, [bin]) ?? resolveInvokingPackageManager();
      const command = buildGlobalPackageCommand(
        manager,
        'install',
        [packageName],
        PLUGIN_RUNTIME_VERSION,
      );
      console.error(`${packageName}: ${before.version ?? '未安装'} → ${PLUGIN_RUNTIME_VERSION}`);
      const result = await runner(command.command, command.args, {
        env: prependCommandPath(
          command.command,
          packageRegistryEnvironment(packageName, process.env),
        ),
      });
      if (result.code !== 0)
        throw new Error(`${packageName} 安装失败 (exit ${result.code})，插件尚未注册。`);
      ready = inspect();
      if (!ready.ready || !ready.installed) {
        throw new Error(
          `${packageName} 更新后仍不可用，请检查 PATH 中的 ${bin} 是否指向 >= ${PLUGIN_RUNTIME_VERSION} 的有效安装。`,
        );
      }
    }
    if (packageName === '@mearl/native-host') {
      const executable = ready.installed!.executable;
      const initialized = await runner(executable, ['--init', '--mode', 'skills'], {
        env: prependCommandPath(executable),
      });
      if (initialized.code !== 0)
        throw new Error(`native-host 初始化失败 (exit ${initialized.code})，插件尚未注册。`);
    }
  }
}
