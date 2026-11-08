import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AgentChatProviderDescriptor, AgentChatStatus } from '@mearl/browser-core';
import { executableNames, type CommandRunner } from '@mearl/daemon-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedAgentPrograms } from '../managed-programs.js';

const codex: AgentChatProviderDescriptor = {
  id: 'codex',
  name: 'Codex',
  available: true,
  capabilities: {
    streaming: true, resume: true, listSessions: true, refreshHistory: true,
    imageInput: true, interrupt: true, requests: true,
  },
};

describe('ManagedAgentPrograms', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'mearl-agent-programs-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('starts browser login with the configured Qoder CLI and coalesces concurrent clicks', async () => {
    const executable = path.join(directory, executableNames('qodercli')[0]!);
    await writeFile(executable, '', { mode: 0o700 });
    vi.stubEnv('MEARL_QODER_PATH', executable);
    const run = vi.fn<CommandRunner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    const spawnLogin = vi.fn(() => child);
    const onSignedIn = vi.fn();
    const programs = new ManagedAgentPrograms(directory, run, spawnLogin as unknown as typeof spawn);
    const login = programs.loginQoder(onSignedIn);
    expect(programs.loginQoder(onSignedIn)).toBe(login);
    await vi.waitFor(() => expect(spawnLogin).toHaveBeenCalledOnce());
    const url = 'https://qoder.com/device/selectAccounts?challenge=example';
    child.stdout.write(`https://example.com/not-a-qoder-login\n  ${url}\n`);
    await expect(login).resolves.toBe(url);
    expect(onSignedIn).not.toHaveBeenCalled();
    child.emit('close', 0);
    expect(onSignedIn).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('lists an uninstalled Qoder alongside Codex and preserves installed providers', () => {
    const programs = new ManagedAgentPrograms(directory);
    expect(programs.describe({ providers: [codex], sessions: [] }).providers).toMatchObject([
      { id: 'codex', available: true },
      { id: 'qoder', available: false, setup: { canInstall: true } },
    ]);
    const qoder = { ...codex, id: 'qoder', name: 'Qoder' };
    const custom = { ...codex, id: 'custom', name: 'Custom' };
    expect(programs.describe({ providers: [codex, qoder, custom], sessions: [] }).providers)
      .toMatchObject([codex, qoder, custom]);
  });

  it('installs the adapter once and skips a CLI already available to that adapter', async () => {
    const run = vi.fn<CommandRunner>(async (_npm, args) => {
      expect(args).toContain('--ignore-scripts');
      expect(args.at(-1)).toMatch(/^@mearl\/plugin-qoder@3\./);
      const staging = args[args.indexOf('--prefix') + 1]!;
      const capability = path.join(staging, 'node_modules/@mearl/plugin-qoder/dist/capability');
      await mkdir(capability, { recursive: true });
      await writeFile(path.join(capability, 'runtime.cjs'), 'module.exports = () => ({ agent: () => ({ id: "qoder" }) })');
      return { code: 0, stdout: '', stderr: '' };
    });
    const programs = new ManagedAgentPrograms(directory, run);
    const status = async (): Promise<AgentChatStatus> => ({
      providers: programs.qoderLoader({ log: () => {}, version: '3.0.0' })
        ? [codex, { ...codex, id: 'qoder', name: 'Qoder' }]
        : [codex],
      sessions: [],
    });

    const install = programs.install('qoder', status);
    expect(programs.install('qoder', status)).toBe(install);
    expect((await install).providers[1]).toMatchObject({ id: 'qoder', available: true });
    expect(run).toHaveBeenCalledOnce();
    await expect(programs.qoderLoader({ log: () => {}, version: '3.0.0' })?.load())
      .resolves.toMatchObject({ id: 'qoder' });
  });

  it('cleans up failed downloads and retries a missing CLI without accepting arbitrary package names', async () => {
    const run = vi.fn<CommandRunner>()
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'failed' })
      .mockImplementationOnce(async (_npm, args) => {
        expect(args.at(-1)).toBe('@openai/codex');
        const staging = args[args.indexOf('--prefix') + 1]!;
        const bin = path.join(staging, 'node_modules/.bin');
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, executableNames('codex')[0]!), '');
        return { code: 0, stdout: '', stderr: '' };
      });
    const programs = new ManagedAgentPrograms(directory, run);
    const status = async (): Promise<AgentChatStatus> => ({
      providers: [{ ...codex, available: (await readdir(directory)).includes('codex') }],
      sessions: [],
    });

    expect(() => programs.install('arbitrary-package', status)).toThrow('Unsupported');
    await expect(programs.install('codex', status)).rejects.toThrow('Could not install');
    expect(await readdir(directory)).toEqual([]);
    const installed = await programs.install('codex', status);
    expect(installed.providers[0]).toMatchObject({ available: true, setup: { canInstall: true } });
    expect(installed.providers[0]?.setup?.loginCommand).toContain(' login');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
