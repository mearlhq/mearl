import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { CLIENT_VERSION } from '../runtimePaths.js';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { npmExecEnvironment } from '@mearl/daemon-core';
import { findOfficialPlugin, readOfficialPluginCatalog } from './officialPluginCatalog.js';
import { findPluginRegistration, pluginDirectory } from './pluginRegistry.js';

const INSTALL_TIMEOUT_MS = 180_000;
const INSTALL_LOCK_STALE_MS = 5 * 60_000;
const MAX_INSTALL_OUTPUT = 1024 * 1024;
const activeInstallations = new Map<string, Promise<void>>();

export type OfficialPluginInstallProgress = (message: string) => void;
export type OfficialPluginInstaller = (
  name: string,
  progress?: OfficialPluginInstallProgress,
) => Promise<void>;

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function installLockPath(name: string): string {
  return join(pluginDirectory(), `.official-${name}.install.lock`);
}

async function acquireInstallLock(name: string): Promise<() => void> {
  const directory = pluginDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = installLockPath(name);
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;

  while (true) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${process.pid}\n`);
      closeSync(descriptor);
      return () => rmSync(lockPath, { force: true });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    if (findPluginRegistration(name)) return () => undefined;
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > INSTALL_LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待安装官方插件 ${name} 超时`);
    }
    await delay(250);
  }
}

function appendOutput(current: string, chunk: Buffer): string {
  if (current.length >= MAX_INSTALL_OUTPUT) return current;
  return (current + chunk.toString('utf8')).slice(0, MAX_INSTALL_OUTPUT);
}

function installWithSetup(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(
      command,
      ['-y', '--@mearl:registry=https://registry.npmjs.org', `@mearl/setup@${CLIENT_VERSION}`, 'plugin', 'ensure', name],
      { env: npmExecEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`安装官方插件 ${name} 超时`));
    }, INSTALL_TIMEOUT_MS);
    child.stdout.on('data', chunk => (stdout = appendOutput(stdout, chunk as Buffer)));
    child.stderr.on('data', chunk => (stderr = appendOutput(stderr, chunk as Buffer)));
    child.once('error', error => finish(error));
    child.once('exit', code => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = (stderr || stdout)
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(-1000);
      finish(
        new Error(
          detail
            ? `安装官方插件 ${name} 失败 (exit ${code}): ${detail}`
            : `安装官方插件 ${name} 失败 (exit ${code})`,
        ),
      );
    });
  });
}

async function installOfficialPlugin(
  name: string,
  progress?: OfficialPluginInstallProgress,
): Promise<void> {
  if (findPluginRegistration(name)) return;
  if (!findOfficialPlugin(name)) throw new Error(`未知官方插件: ${name}`);
  const releaseLock = await acquireInstallLock(name);
  try {
    if (findPluginRegistration(name)) return;
    const accepted = JSON.stringify(readOfficialPluginCatalog());
    if (!findOfficialPlugin(name)) throw new Error('PLUGIN_CATALOG_SELECTION_CHANGED');
    progress?.(`正在安装官方插件 ${name}...`);
    await installWithSetup(name);
    if (JSON.stringify(readOfficialPluginCatalog()) !== accepted) throw new Error('PLUGIN_CATALOG_SELECTION_CHANGED');
    if (!findPluginRegistration(name)) {
      throw new Error(`官方插件 ${name} 安装完成后仍未注册`);
    }
    progress?.(`官方插件 ${name} 已安装。`);
  } finally {
    releaseLock();
  }
}

export const ensureOfficialPluginRegistered: OfficialPluginInstaller = (name, progress) => {
  const active = activeInstallations.get(name);
  if (active) return active;
  const installation = installOfficialPlugin(name, progress).finally(() => {
    activeInstallations.delete(name);
  });
  activeInstallations.set(name, installation);
  return installation;
};
