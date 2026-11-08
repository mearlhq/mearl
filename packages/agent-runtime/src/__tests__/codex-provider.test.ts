import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexAgentProvider,
  codexAppExecutableCandidatePaths,
  codexExecutableCandidatePaths,
  codexThreadUrl,
  codexWorkspaceUrl,
  compareCodexVersions,
  externalOpenCommand,
  normalizeCodexVersion,
} from '../codex-provider.js';
import type { AgentProviderEvent } from '../provider.js';
import { agentSpawnCommand, createAgentChildEnv } from '../process-env.js';

describe('CodexAgentProvider', () => {
  it('warms the app-server without creating a thread', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    const ensureStarted = vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi.spyOn(provider as any, 'request');

    await provider.prepare();

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it('prevents an outstanding executable probe from launching after disposal', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    let resolve!: (value: unknown) => void;
    vi.spyOn(provider as any, 'resolveExecutable').mockImplementation(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const pending = provider.prepare();
    const assertion = expect(pending).rejects.toThrow('disposed during startup');
    provider.dispose();
    resolve({ executable: '/unused/codex', error: null });
    await assertion;
    expect((provider as any).process).toBeNull();
  });

  it('reads advertised model options, paginates and filters hidden or malformed entries without starting a thread', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi
      .spyOn(provider as any, 'request')
      .mockResolvedValueOnce({
        data: [
          { model: 'available', displayName: 'Available', isDefault: true },
          { model: 'hidden', hidden: true },
          { model: 4 },
        ],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'second', description: 'Another model' }, { model: 'available' }],
        nextCursor: null,
      });
    expect(await provider.listModels()).toEqual([
      { id: 'available', displayName: 'Available', isDefault: true },
      { id: 'second', displayName: 'second', description: 'Another model', isDefault: false },
    ]);
    expect(request.mock.calls.map(([method]) => method)).toEqual(['model/list', 'model/list']);
    expect(request.mock.lastCall?.[1]).toEqual({ limit: 100, cursor: 'next' });
  });

  it('exposes supported reasoning efforts and validates catalog defaults', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    vi.spyOn(provider as any, 'request').mockResolvedValue({
      data: [
        {
          model: 'fast',
          supportedReasoningEfforts: [
            { reasoningEffort: 'none' },
            { reasoningEffort: 'low' },
            { reasoningEffort: 'future' },
          ],
          defaultReasoningEffort: 'low',
        },
        { model: 'unknown', supportedReasoningEfforts: [], defaultReasoningEffort: 'future' },
      ],
    });
    expect(await provider.listModels()).toEqual([
      {
        id: 'fast',
        displayName: 'fast',
        isDefault: false,
        reasoningEfforts: ['none', 'low'],
        defaultReasoningEffort: 'low',
      },
      { id: 'unknown', displayName: 'unknown', isDefault: false, reasoningEfforts: [] },
    ]);
  });

  it('builds the Codex App deep link and platform open commands safely', () => {
    const url = codexThreadUrl('019f807c-e46f-7822-af2b-2d6f94b080bc');

    expect(url).toBe('codex://threads/019f807c-e46f-7822-af2b-2d6f94b080bc');
    expect(externalOpenCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] });
    expect(externalOpenCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
    expect(externalOpenCommand(url, 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'start', '', url],
    });
    expect(() => codexThreadUrl('thread/id')).toThrow('invalid thread id');
    expect(codexWorkspaceUrl('/workspace/my project')).toBe(
      'codex://threads/new?path=%2Fworkspace%2Fmy%20project',
    );
  });

  it('starts an in-memory thread when ephemeral mode is enabled', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi
      .spyOn(provider as any, 'request')
      .mockResolvedValue({ thread: { id: 'thread-ephemeral' }, model: 'gpt-5.6-codex' });

    await expect(provider.startSession({ cwd: '/workspace', ephemeral: true })).resolves.toBe(
      'thread-ephemeral',
    );
    expect(request).toHaveBeenCalledWith('thread/start', {
      cwd: '/workspace',
      sandbox: 'danger-full-access',
      approvalPolicy: 'untrusted',
      ephemeral: true,
    });
    expect(provider.getSessionModel('thread-ephemeral')).toEqual({ id: 'gpt-5.6-codex' });
  });

  it('starts temporary analysis threads with read-only permissions', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi
      .spyOn(provider as any, 'request')
      .mockResolvedValue({ thread: { id: 'thread-analysis' } });

    await provider.startSession({ ephemeral: true, readOnly: true, modelId: 'gpt-6-luna' });

    expect(request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ephemeral: true,
        model: 'gpt-6-luna',
      }),
    );
  });

  it('uses unrestricted access with approvals even without a reference directory', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi
      .spyOn(provider as any, 'request')
      .mockResolvedValue({ thread: { id: 'thread-read-only' } });

    await provider.startSession({});

    expect(request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'danger-full-access',
        approvalPolicy: 'untrusted',
      }),
    );

    await provider.resumeSession('thread-read-only', {});
    expect(request).toHaveBeenLastCalledWith(
      'thread/resume',
      expect.objectContaining({
        sandbox: 'danger-full-access',
        approvalPolicy: 'untrusted',
      }),
    );
  });

  it('requests detailed reasoning summaries while sending pasted images', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi.spyOn(provider as any, 'request').mockResolvedValue({
      turn: { id: 'turn-image' },
    });

    await provider.sendMessage('thread-image', 'Inspect this screenshot', [
      { data: 'AQID', mimeType: 'image/png', name: 'screenshot.png' },
    ]);

    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-image',
      input: [
        { type: 'text', text: 'Inspect this screenshot', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,AQID' },
      ],
      summary: 'detailed',
    });
  });

  it('uses low effort without reasoning summaries for a temporary task', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi
      .spyOn(provider as any, 'request')
      .mockResolvedValue({ turn: { id: 'turn-fast' } });

    await provider.sendMessage('thread-fast', 'Group tabs', [], {
      reasoningEffort: 'low',
      reasoningSummary: 'none',
    });

    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-fast',
      input: [{ type: 'text', text: 'Group tabs', text_elements: [] }],
      effort: 'low',
      summary: 'none',
    });
  });

  it('lists saved threads by recent activity', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi.spyOn(provider as any, 'request').mockResolvedValue({
      data: [
        {
          id: 'thread-1',
          name: null,
          preview: 'Inspect the checkout flow',
          cwd: '/workspace',
          updatedAt: 1_700_000_000,
          recencyAt: 1_700_000_100,
        },
      ],
      nextCursor: 'next-page',
    });

    await expect(provider.listSessions({ limit: 25 })).resolves.toEqual({
      sessions: [
        {
          providerSessionId: 'thread-1',
          title: 'Inspect the checkout flow',
          cwd: '/workspace',
          updatedAt: 1_700_000_100_000,
        },
      ],
      nextCursor: 'next-page',
    });
    expect(request).toHaveBeenCalledWith('thread/list', {
      cursor: null,
      limit: 25,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    });
  });

  it('lists every skill returned by the Codex app-server without filtering', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi.spyOn(provider as any, 'request').mockResolvedValue({
      data: [
        {
          cwd: '/workspace',
          errors: [],
          skills: [
            {
              name: 'repo-skill',
              path: '/workspace/.agents/skills/repo-skill/SKILL.md',
              scope: 'repo',
              description: 'Repository workflow',
              enabled: true,
            },
            {
              name: 'system-skill',
              path: '/opt/codex/skills/system-skill/SKILL.md',
              scope: 'system',
              description: 'System workflow',
              enabled: false,
            },
          ],
        },
      ],
    });

    await expect(provider.listSkills('/workspace')).resolves.toEqual([
      {
        name: 'repo-skill',
        path: '/workspace/.agents/skills/repo-skill/SKILL.md',
        scope: 'project',
      },
      {
        name: 'system-skill',
        path: '/opt/codex/skills/system-skill/SKILL.md',
        scope: 'system',
      },
    ]);
    expect(request).toHaveBeenCalledWith('skills/list', {
      cwds: ['/workspace'],
      forceReload: true,
    });
  });

  it('returns saved thread messages when resuming', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    vi.spyOn(provider as any, 'request').mockResolvedValue({
      thread: {
        id: 'thread-1',
        turns: [
          {
            id: 'turn-1',
            startedAt: 1_700_000_000,
            completedAt: 1_700_000_001,
            items: [
              {
                id: 'user-1',
                type: 'userMessage',
                content: [
                  { type: 'text', text: 'Continue the fix' },
                  { type: 'image', url: 'data:image/png;base64,AQID' },
                ],
              },
              { id: 'assistant-1', type: 'agentMessage', text: 'Done' },
            ],
          },
        ],
      },
    });

    await expect(provider.resumeSession('thread-1', {})).resolves.toEqual({
      providerSessionId: 'thread-1',
      historyComplete: true,
      history: [
        {
          kind: 'lifecycle',
          method: 'chat/userMessage',
          params: { text: 'Continue the fix', imageCount: 1 },
          timestamp: 1_700_000_001_000,
        },
        {
          kind: 'notification',
          method: 'item/completed',
          params: {
            turnId: 'turn-1',
            item: { id: 'assistant-1', type: 'agentMessage', text: 'Done' },
          },
          timestamp: 1_700_000_001_000,
        },
      ],
    });
  });

  it('routes legacy approval requests by conversation id', () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');

    expect((provider as any).extractThreadId({ conversationId: 'thread-legacy' })).toBe(
      'thread-legacy',
    );
  });

  it('updates configured and active models from Codex notifications', () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    const events: AgentProviderEvent[] = [];
    provider.onEvent(event => events.push(event));

    (provider as any).handleLine(
      JSON.stringify({
        method: 'thread/settings/updated',
        params: {
          threadId: 'thread-1',
          threadSettings: { model: 'gpt-5.6-codex' },
        },
      }),
    );
    (provider as any).handleLine(
      JSON.stringify({
        method: 'model/rerouted',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          fromModel: 'gpt-5.6-codex',
          toModel: 'gpt-5.6-codex-mini',
          reason: 'fallback',
        },
      }),
    );

    expect(provider.getSessionModel('thread-1')).toEqual({ id: 'gpt-5.6-codex' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'session/model/updated',
          params: { model: { id: 'gpt-5.6-codex' } },
        }),
        expect.objectContaining({
          method: 'session/activeModel/updated',
          params: { model: { id: 'gpt-5.6-codex-mini' } },
        }),
        expect.objectContaining({ method: 'thread/settings/updated' }),
        expect.objectContaining({ method: 'model/rerouted' }),
      ]),
    );
  });

  it('restarts a child that exists without a completed initialization', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    const staleChild = { killed: false, kill: vi.fn() };
    (provider as any).process = staleChild;
    (provider as any).initialized = false;
    const start = vi.spyOn(provider as any, 'start').mockImplementation(async () => {
      (provider as any).initialized = true;
    });

    await (provider as any).ensureStarted();

    expect(staleChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(start).toHaveBeenCalledOnce();
  });

  it('skips an unusable Codex CLI and selects the next compatible installation', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'resolveExecutableCandidates').mockReturnValue([
      '/opt/node/bin/codex',
      '/home/test/.npm-global/bin/codex',
    ]);
    const probe = vi
      .spyOn(provider as any, 'probeExecutable')
      .mockResolvedValueOnce('unknown subcommand app-server')
      .mockResolvedValueOnce(null);
    vi.spyOn(provider as any, 'readExecutableVersion').mockResolvedValue(null);

    await expect(provider.getDescriptor()).resolves.toEqual(
      expect.objectContaining({ available: true }),
    );
    expect(probe).toHaveBeenNthCalledWith(1, '/opt/node/bin/codex');
    expect(probe).toHaveBeenNthCalledWith(2, '/home/test/.npm-global/bin/codex');
  });

  it('selects the newer App runtime from its nested macOS bundle', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'resolveExecutableCandidates').mockReturnValue([
      '/cli/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    ]);
    vi.spyOn(provider as any, 'probeExecutable').mockResolvedValue(null);
    vi.spyOn(provider as any, 'readExecutableVersion').mockImplementation(async executable =>
      executable === '/cli/codex' ? '0.156.1' : '0.162.0-alpha.2',
    );

    await expect((provider as any).resolveExecutable()).resolves.toEqual({
      executable:
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      error: null,
    });
  });

  it('selects a newer CLI over the App runtime', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    const app =
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
    vi.spyOn(provider as any, 'resolveExecutableCandidates').mockReturnValue([app, '/cli/codex']);
    vi.spyOn(provider as any, 'probeExecutable').mockResolvedValue(null);
    vi.spyOn(provider as any, 'readExecutableVersion').mockImplementation(async executable =>
      executable === app ? '0.162.0-alpha.2' : '0.163.0',
    );

    await expect((provider as any).resolveExecutable()).resolves.toEqual({
      executable: '/cli/codex',
      error: null,
    });
  });

  it('falls back to a compatible CLI when the newer App runtime is unusable', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    const app =
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
    vi.spyOn(provider as any, 'resolveExecutableCandidates').mockReturnValue(['/cli/codex', app]);
    vi.spyOn(provider as any, 'probeExecutable').mockImplementation(async executable =>
      executable === app ? 'app-server unavailable' : null,
    );
    vi.spyOn(provider as any, 'readExecutableVersion').mockImplementation(async executable =>
      executable === app ? '0.162.0-alpha.2' : '0.156.1',
    );

    await expect((provider as any).resolveExecutable()).resolves.toEqual({
      executable: '/cli/codex',
      error: null,
    });
  });

  it('discovers Codex installations from other NVM and FNM Node versions', () => {
    const directory = (name: string, isDirectory = true) => ({
      name,
      isDirectory: () => isDirectory,
    });
    const readdirSync = vi.fn((root: string) => {
      if (root === '/home/test/.nvm/versions/node') {
        return [directory('v20.19.5'), directory('v25.0.0'), directory('current', false)];
      }
      if (root === '/home/test/.local/share/fnm/node-versions') {
        return [directory('v22.14.0')];
      }
      throw new Error('unexpected directory');
    }) as unknown as typeof import('node:fs').readdirSync;

    const candidates = codexExecutableCandidatePaths({
      env: {
        MEARL_CODEX_PATH: '/configured/codex',
        PATH: '/terminal/bin:/usr/bin',
      },
      homedir: () => '/home/test',
      platform: 'linux',
      processExecPath: '/current-node/bin/node',
      readdirSync,
    });

    expect(candidates[0]).toBe('/configured/codex');
    expect(candidates[1]).toBe('/current-node/bin/codex');
    expect(candidates).toContain('/home/test/.nvm/versions/node/v25.0.0/bin/codex');
    expect(candidates).toContain('/home/test/.nvm/versions/node/v20.19.5/bin/codex');
    expect(candidates).toContain(
      '/home/test/.local/share/fnm/node-versions/v22.14.0/installation/bin/codex',
    );
    expect(candidates.indexOf('/home/test/.nvm/versions/node/v25.0.0/bin/codex')).toBeLessThan(
      candidates.indexOf('/home/test/.nvm/versions/node/v20.19.5/bin/codex'),
    );
    expect(candidates.indexOf('/home/test/.nvm/versions/node/v20.19.5/bin/codex')).toBeLessThan(
      candidates.indexOf('/terminal/bin/codex'),
    );
  });

  it('discovers the system and user Codex App runtimes on macOS', () => {
    expect(
      codexAppExecutableCandidatePaths({
        env: {},
        homedir: () => '/Users/test',
        platform: 'darwin',
      }),
    ).toEqual([
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Users/test/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Users/test/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Users/test/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Users/test/Applications/Codex.app/Contents/Resources/codex',
    ]);
  });

  it('does not treat an IDE-bundled Codex binary as an automatic runtime', () => {
    const candidates = codexExecutableCandidatePaths({
      env: {
        PATH: [
          '/Users/test/.vscode/extensions/openai.chatgpt-1.0/bin/macos-aarch64',
          '/usr/local/bin',
        ].join(path.delimiter),
      },
      homedir: () => '/Users/test',
      platform: 'darwin',
      processExecPath: '/usr/local/bin/node',
      readdirSync: vi.fn(() => []),
    });

    expect(candidates).not.toContain(
      '/Users/test/.vscode/extensions/openai.chatgpt-1.0/bin/macos-aarch64/codex',
    );
    expect(candidates).toContain('/Applications/ChatGPT.app/Contents/Resources/codex');
  });

  it('reports each candidate when no Codex CLI supports app-server', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'resolveExecutableCandidates').mockReturnValue([
      '/opt/node/bin/codex',
      '/home/test/.npm-global/bin/codex',
    ]);
    vi.spyOn(provider as any, 'probeExecutable')
      .mockResolvedValueOnce('unknown subcommand app-server')
      .mockResolvedValueOnce('app-server check exited with code 1');
    vi.spyOn(provider as any, 'readExecutableVersion').mockResolvedValue(null);

    const descriptor = await provider.getDescriptor();

    expect(descriptor.available).toBe(false);
    expect(descriptor.error).toContain('/opt/node/bin/codex: unknown subcommand app-server');
    expect(descriptor.error).toContain(
      '/home/test/.npm-global/bin/codex: app-server check exited with code 1',
    );
  });
});

describe('Codex runtime versions', () => {
  it('normalizes CLI output and package versions', () => {
    expect(normalizeCodexVersion('codex-cli 0.156.1\n')).toBe('0.156.1');
    expect(normalizeCodexVersion('0.155.0-alpha.16.3')).toBe('0.155.0-alpha.16.3');
    expect(normalizeCodexVersion('Codex 26.917')).toBeNull();
  });

  it('compares stable and prerelease versions using semantic version precedence', () => {
    expect(compareCodexVersions('0.156.1', '0.155.0-alpha.16.3')).toBeGreaterThan(0);
    expect(compareCodexVersions('0.156.1', '0.156.1-alpha.1')).toBeGreaterThan(0);
    expect(compareCodexVersions('0.155.0-alpha.16.3', '0.155.0-alpha.9.2')).toBeGreaterThan(0);
  });
});

describe('createAgentChildEnv', () => {
  it('prepends the native-host Node directory to a restricted PATH', () => {
    const delimiter = path.delimiter;
    const result = createAgentChildEnv(
      { PATH: ['/usr/bin', '/bin'].join(delimiter), HOME: '/home/test' },
      '/opt/node/bin/node',
    );

    expect(result.PATH).toBe(['/opt/node/bin', '/usr/bin', '/bin'].join(delimiter));
    expect(result.HOME).toBe('/home/test');
  });

  it('does not duplicate the Node directory', () => {
    const delimiter = path.delimiter;
    const result = createAgentChildEnv(
      { PATH: ['/opt/node/bin', '/usr/bin'].join(delimiter) },
      '/opt/node/bin/node',
    );

    expect(result.PATH).toBe(['/opt/node/bin', '/usr/bin'].join(delimiter));
  });

  it('preserves the original path key casing', () => {
    const result = createAgentChildEnv({ Path: 'C:\\Windows' }, 'C:\\node\\node.exe');

    expect(result.Path).toBeDefined();
    expect(result.PATH).toBeUndefined();
  });

  it('runs Windows command shims through the command interpreter', () => {
    expect(
      agentSpawnCommand('C:\\Program Files\\Codex\\codex.cmd', ['app-server'], 'win32', 'cmd.exe'),
    ).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\Program Files\\Codex\\codex.cmd', 'app-server'],
    });
    expect(agentSpawnCommand('/usr/local/bin/codex', ['app-server'], 'darwin')).toEqual({
      command: '/usr/local/bin/codex',
      args: ['app-server'],
    });
  });
});
