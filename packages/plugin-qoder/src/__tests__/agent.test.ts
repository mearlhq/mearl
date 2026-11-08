import os from 'node:os';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  parseQoderSkillsList,
  QoderAgentProvider,
  qoderExecutableCandidatePaths,
  qoderInstallCommand,
  qoderModelInfo,
} from '../agent.js';

function createProvider() {
  const provider = new QoderAgentProvider(vi.fn(), '1.0.0');
  (provider as any).sdk = acp;
  return provider;
}

function activeTurn() {
  return {
    id: 'turn-1',
    assistantItemId: 'message-1',
    assistantText: '',
    reasoningItemId: 'reasoning-1',
    reasoningText: '',
    reasoningStarted: false,
    planItemId: 'plan-1',
    toolTitles: new Map<string, string>(),
  };
}

describe('QoderAgentProvider', () => {
  it('warms ACP without creating a session', async () => {
    const provider = createProvider();
    const ensureStarted = vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);

    await provider.prepare();

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect((provider as any).sessions.size).toBe(0);
  });

  it('uses the official platform-specific installation commands', () => {
    expect(qoderInstallCommand('darwin')).toBe('curl -fsSL https://qoder.com/install | bash');
    expect(qoderInstallCommand('win32')).toBe('npm install -g @qoder-ai/qodercli');
  });

  it('reads only an explicitly categorized ACP model option', () => {
    expect(
      qoderModelInfo([
        {
          id: 'model-selector',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'qoder-pro',
          options: [
            {
              group: 'recommended',
              name: 'Recommended',
              options: [{ value: 'qoder-pro', name: 'Qoder Pro' }],
            },
          ],
        },
      ]),
    ).toEqual({ id: 'qoder-pro', displayName: 'Qoder Pro' });
    expect(
      qoderModelInfo([
        {
          id: 'model-selector',
          name: 'Model',
          type: 'select',
          currentValue: 'qoder-pro',
          options: [{ value: 'qoder-pro', name: 'Qoder Pro' }],
        },
      ]),
    ).toBeUndefined();
  });

  it('skips an unusable Qoder CLI and selects the next installation', async () => {
    const provider = createProvider();
    vi.spyOn(provider as any, 'resolveExecutableCandidates').mockReturnValue([
      '/opt/node/bin/qodercli',
      '/home/test/.local/bin/qodercli',
    ]);
    const probe = vi
      .spyOn(provider as any, 'probeExecutable')
      .mockResolvedValueOnce('Qoder CLI check exited with code 1')
      .mockResolvedValueOnce(null);

    await expect(provider.getDescriptor()).resolves.toEqual(
      expect.objectContaining({ available: true }),
    );
    expect(probe).toHaveBeenNthCalledWith(1, '/opt/node/bin/qodercli');
    expect(probe).toHaveBeenNthCalledWith(2, '/home/test/.local/bin/qodercli');
  });

  it('discovers official and version-manager Qoder installations outside PATH', () => {
    const entry = (name: string, kind: 'directory' | 'file') => ({
      name,
      isDirectory: () => kind === 'directory',
      isFile: () => kind === 'file',
    });
    const readdirSync = vi.fn((root: string) => {
      if (root === '/home/test/.qoder/bin/qodercli') {
        return [entry('qodercli-1.1.2', 'file'), entry('version.txt', 'file')];
      }
      if (root === '/home/test/.nvm/versions/node') {
        return [entry('v25.0.0', 'directory')];
      }
      if (root === '/home/test/.local/share/fnm/node-versions') return [];
      throw new Error('unexpected directory');
    }) as unknown as typeof import('node:fs').readdirSync;

    const candidates = qoderExecutableCandidatePaths({
      env: { PATH: '/usr/bin' },
      homedir: () => '/home/test',
      platform: 'linux',
      processExecPath: '/current-node/bin/node',
      readdirSync,
    });

    expect(candidates).toContain('/home/test/.local/bin/qodercli');
    expect(candidates).toContain('/home/test/.qoder/bin/qodercli/qodercli-1.1.2');
    expect(candidates).toContain('/home/test/.nvm/versions/node/v25.0.0/bin/qodercli');
    expect(candidates.indexOf('/home/test/.qoder/bin/qodercli/qodercli-1.1.2')).toBeLessThan(
      candidates.indexOf('/home/test/.nvm/versions/node/v25.0.0/bin/qodercli'),
    );
  });

  it('reports each candidate when no Qoder CLI is usable', async () => {
    const provider = createProvider();
    vi.spyOn(provider as any, 'resolveExecutableCandidates').mockReturnValue([
      '/opt/node/bin/qodercli',
      '/home/test/.local/bin/qodercli',
    ]);
    vi.spyOn(provider as any, 'probeExecutable')
      .mockResolvedValueOnce('Qoder CLI check exited with code 1')
      .mockResolvedValueOnce('Timed out while checking Qoder CLI availability.');

    const descriptor = await provider.getDescriptor();

    expect(descriptor.available).toBe(false);
    expect(descriptor.error).toContain(
      '/opt/node/bin/qodercli: Qoder CLI check exited with code 1',
    );
    expect(descriptor.error).toContain(
      '/home/test/.local/bin/qodercli: Timed out while checking Qoder CLI availability.',
    );
  });

  it('lists all Qoder skills including built-in skills', async () => {
    const output = `Discovered Agent Skills:

project-skill [Enabled]
  Description: Project workflow
  Location:    /workspace/.qoder/skills/project-skill/SKILL.md

global-skill [Disabled]
  Description: Global workflow
  Location:    /Users/test/.qoder/skills/global-skill/SKILL.md

debug [Enabled] [Built-in]
  Description: Debug workflow
  Location:    bundled
`;
    expect(parseQoderSkillsList(output, '/workspace', '/Users/test')).toEqual([
      {
        name: 'project-skill',
        path: '/workspace/.qoder/skills/project-skill/SKILL.md',
        scope: 'project',
      },
      {
        name: 'global-skill',
        path: '/Users/test/.qoder/skills/global-skill/SKILL.md',
        scope: 'global',
      },
      {
        name: 'debug',
        path: 'bundled',
        scope: 'built-in',
      },
    ]);

    const provider = createProvider();
    vi.spyOn(provider as any, 'resolveExecutable').mockResolvedValue({
      executable: '/usr/local/bin/qodercli',
      error: null,
    });
    const runSkillsList = vi.spyOn(provider as any, 'runSkillsList').mockResolvedValue(output);
    await provider.listSkills('/workspace');
    expect(runSkillsList).toHaveBeenCalledWith('/usr/local/bin/qodercli', '/workspace');
  });

  it('starts without a reference directory and does not inject read-only instructions', async () => {
    const provider = createProvider();
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        configOptions: [
          {
            id: 'model-selector',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'qoder-pro',
            options: [{ value: 'qoder-pro', name: 'Qoder Pro' }],
          },
        ],
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    const child = { killed: false, kill: vi.fn() };
    (provider as any).process = child;
    (provider as any).context = { request, notify: vi.fn() };

    await expect(provider.startSession({})).resolves.toBe('session-1');
    expect(request).toHaveBeenNthCalledWith(1, 'session/new', {
      cwd: os.homedir(),
      mcpServers: [],
    });
    expect(provider.getSessionModel('session-1')).toEqual({
      id: 'qoder-pro',
      displayName: 'Qoder Pro',
    });

    await provider.sendMessage('session-1', 'Inspect the project');
    expect(request).toHaveBeenNthCalledWith(2, 'session/prompt', {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'Inspect the project' }],
    });
    child.killed = true;
    provider.dispose();
  });

  it('lists ACP sessions when Qoder advertises the capability', async () => {
    const provider = createProvider();
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({
      sessions: [
        {
          sessionId: 'session-1',
          cwd: '/workspace',
          title: 'Debug checkout',
          updatedAt: '2026-07-21T10:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    (provider as any).initializeResponse = {
      agentCapabilities: { sessionCapabilities: { list: {} } },
    };
    (provider as any).context = { request };

    await expect(provider.listSessions({ limit: 25 })).resolves.toEqual({
      sessions: [
        {
          providerSessionId: 'session-1',
          cwd: '/workspace',
          title: 'Debug checkout',
          updatedAt: Date.parse('2026-07-21T10:00:00.000Z'),
        },
      ],
    });
    expect(request).toHaveBeenCalledWith('session/list', { cursor: null });
  });

  it('loads and normalizes ACP history when continuing a saved session', async () => {
    const provider = createProvider();
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi.fn(async (method: string) => {
      if (method === 'session/load') {
        for (const update of [
          {
            sessionUpdate: 'user_message_chunk',
            messageId: 'user-1',
            content: { type: 'text', text: 'Inspect ' },
          },
          {
            sessionUpdate: 'user_message_chunk',
            messageId: 'user-1',
            content: { type: 'text', text: 'this' },
          },
          {
            sessionUpdate: 'user_message_chunk',
            messageId: 'user-1',
            content: { type: 'image', data: 'AQID', mimeType: 'image/png' },
          },
          {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'agent-1',
            content: { type: 'text', text: 'Done' },
          },
        ]) {
          (provider as any).handleSessionUpdate({ sessionId: 'session-1', update });
        }
      }
      return {};
    });
    (provider as any).initializeResponse = {
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    };
    (provider as any).context = { request };

    await expect(provider.resumeSession('session-1', { cwd: '/workspace' })).resolves.toEqual({
      providerSessionId: 'session-1',
      historyComplete: true,
      history: [
        expect.objectContaining({
          method: 'chat/userMessage',
          params: { text: 'Inspect this', imageCount: 1 },
        }),
        expect.objectContaining({
          method: 'item/completed',
          params: {
            item: {
              id: 'qoder_history_agent_agent-1',
              type: 'agentMessage',
              text: 'Done',
            },
          },
        }),
      ],
    });
    expect(request).toHaveBeenCalledWith('session/load', {
      sessionId: 'session-1',
      cwd: '/workspace',
      mcpServers: [],
    });
  });

  it('marks history as incomplete when only ACP resume is available', async () => {
    const provider = createProvider();
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({});
    (provider as any).initializeResponse = {
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    };
    (provider as any).context = { request };

    await expect(provider.resumeSession('session-1', { cwd: '/workspace' })).resolves.toEqual({
      providerSessionId: 'session-1',
    });
    expect(request).toHaveBeenCalledWith('session/resume', {
      sessionId: 'session-1',
      cwd: '/workspace',
      mcpServers: [],
    });
  });

  it('maps ACP thought, message, and tool updates to chat events', () => {
    const provider = createProvider();
    const events: Array<{ method: string; params: any }> = [];
    provider.onEvent(event => events.push(event));
    const turn = activeTurn();
    (provider as any).sessions.set('session-1', {
      cwd: '/workspace',
      instructionsSent: true,
      activeTurn: turn,
    });

    (provider as any).handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Checking the page' },
      },
    });
    (provider as any).handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Take snapshot',
        status: 'in_progress',
      },
    });
    (provider as any).handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done' },
      },
    });

    expect(events.map(event => event.method)).toEqual([
      'item/started',
      'item/reasoning/summaryTextDelta',
      'item/started',
      'item/agentMessage/delta',
    ]);
    expect(events[2]?.params.item).toMatchObject({
      id: 'tool-1',
      type: 'dynamicToolCall',
      namespace: 'qoder',
      tool: 'Take snapshot',
    });
    expect(turn.assistantText).toBe('Done');
    provider.dispose();
  });

  it('updates and clears the model from ACP config notifications', () => {
    const provider = createProvider();
    const events: Array<{ method: string; params: any }> = [];
    provider.onEvent(event => events.push(event));
    (provider as any).sessions.set('session-1', {
      cwd: '/workspace',
      instructionsSent: true,
    });

    (provider as any).handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model-selector',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'qoder-max',
            options: [{ value: 'qoder-max', name: 'Qoder Max' }],
          },
        ],
      },
    });

    expect(provider.getSessionModel('session-1')).toEqual({
      id: 'qoder-max',
      displayName: 'Qoder Max',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        method: 'session/model/updated',
        params: { model: { id: 'qoder-max', displayName: 'Qoder Max' } },
      }),
    );

    (provider as any).handleSessionUpdate({
      sessionId: 'session-1',
      update: { sessionUpdate: 'config_option_update', configOptions: [] },
    });
    expect(provider.getSessionModel('session-1')).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        method: 'session/model/updated',
        params: { model: null },
      }),
    );
  });

  it('forwards ACP permission requests and resolves the selected option', async () => {
    const provider = createProvider();
    const listener = vi.fn();
    provider.onEvent(listener);

    const responsePromise = (provider as any).handlePermissionRequest(7, {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Run command' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSessionId: 'session-1',
        kind: 'request',
        method: 'acp/requestPermission',
        requestId: 7,
      }),
    );

    provider.respondToRequest(7, {
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    provider.dispose();
  });

  it('prepends browser instructions to the first ACP prompt only', async () => {
    const provider = createProvider();
    const request = vi.fn(() => new Promise(() => {}));
    const child = { killed: false, kill: vi.fn() };
    (provider as any).process = child;
    (provider as any).context = { request, notify: vi.fn() };
    (provider as any).initializeResponse = {
      agentCapabilities: { promptCapabilities: { image: true } },
    };
    (provider as any).sessions.set('session-1', {
      cwd: '/workspace',
      developerInstructions: 'Use mearl with {"tabId": 88}.',
      instructionsSent: false,
    });

    await provider.sendMessage('session-1', 'Inspect this page', [
      { data: 'AQID', mimeType: 'image/png', name: 'screenshot.png' },
    ]);

    expect(request).toHaveBeenCalledWith('session/prompt', {
      sessionId: 'session-1',
      prompt: [
        {
          type: 'text',
          text: 'Use mearl with {"tabId": 88}.\n\nUser request:\nInspect this page',
        },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    });
    child.killed = true;
    provider.dispose();
  });
});
