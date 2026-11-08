import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentChatModelInfo,
  AgentChatProviderDescriptor,
  AgentInstalledSkill,
} from '@mearl/browser-core';
import { AgentChatManager } from '../manager.js';
import type {
  AgentProvider,
  AgentProviderEvent,
  AgentProviderSessionOptions,
} from '@mearl/agent-runtime';

class FakeProvider implements AgentProvider {
  readonly id: string;
  readonly respondToRequest = vi.fn();
  readonly dispose = vi.fn();
  readonly closeSession = vi.fn(async () => {});
  readonly interrupt = vi.fn(async () => {});
  readonly openSession = vi.fn(async () => {});
  readonly openWorkspace = vi.fn(async (_cwd: string) => {});
  readonly sendMessage = vi.fn(async () => ({ turnId: 'turn-1' }));
  readonly validateMessageInput = vi.fn(async () => {});
  readonly prepare = vi.fn(async () => {});
  readonly getSessionModel = vi.fn(
    (_providerSessionId: string): AgentChatModelInfo | undefined => undefined,
  );
  readonly startSession = vi.fn(async (_options: AgentProviderSessionOptions) => 'thread-1');
  readonly resumeSession = vi.fn(
    async (providerSessionId: string, _options: AgentProviderSessionOptions) => ({
      providerSessionId,
    }),
  );
  readonly listSessions = vi.fn(async () => ({
    sessions: [
      {
        providerSessionId: 'saved-thread',
        title: 'Saved conversation',
        cwd: process.cwd(),
        updatedAt: 123,
      },
    ],
  }));
  readonly listSkills = vi.fn(async (_cwd?: string): Promise<AgentInstalledSkill[]> => []);
  private listeners = new Set<(event: AgentProviderEvent) => void>();

  constructor(id = 'fake') {
    this.id = id;
  }

  async getDescriptor(): Promise<AgentChatProviderDescriptor> {
    return {
      id: this.id,
      name: 'Fake',
      available: true,
      capabilities: {
        streaming: true,
        resume: true,
        listSessions: true,
        refreshHistory: true,
        imageInput: true,
        interrupt: true,
        requests: true,
      },
    };
  }

  onEvent(listener: (event: AgentProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

describe('AgentChatManager', () => {
  it.each([true, false])('reconnects Qoder after an authentication error (saved session: %s)', async saved => {
    const qoder = new FakeProvider('qoder');
    const codex = new FakeProvider('codex');
    const emit = vi.fn();
    const manager = new AgentChatManager([qoder, codex], emit);
    const session = await manager.startSession({ providerId: 'qoder' });
    await manager.sendMessage({ sessionId: session.id, message: 'first attempt' });
    qoder.emit({
      providerSessionId: session.providerSessionId,
      kind: 'error',
      method: 'chat/error',
      params: { message: 'Authentication required: Authentication is required.' },
    });
    qoder.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'failed' } },
    });
    if (!saved) {
      qoder.resumeSession.mockRejectedValueOnce(new Error('Invalid params: Invalid session identifier'));
      qoder.startSession.mockResolvedValueOnce('thread-2');
    }

    await manager.sendMessage({ sessionId: session.id, message: 'after sign-in' });

    expect(qoder.dispose).toHaveBeenCalledOnce();
    expect(codex.dispose).not.toHaveBeenCalled();
    expect(qoder.resumeSession).toHaveBeenCalledWith('thread-1', expect.anything());
    expect(qoder.sendMessage).toHaveBeenLastCalledWith(saved ? 'thread-1' : 'thread-2', 'after sign-in');
    expect((await manager.getStatus()).sessions[0]?.providerSessionId).toBe(saved ? 'thread-1' : 'thread-2');
    if (!saved) {
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.id,
        method: 'session/reconnected',
        params: { providerSessionId: 'thread-2' },
      }));
    }
  });

  it('discovers installed providers and retires removed runtimes after their conversations close', async () => {
    const provider = new FakeProvider('sample');
    const revision = {};
    let installed = [{ id: 'sample', revision, load: async () => provider }];
    const manager = new AgentChatManager([], vi.fn(), { installedProviders: () => installed });
    expect((await manager.getStatus()).providers.map(value => value.id)).toEqual(['sample']);
    const session = await manager.startSession({ providerId: 'sample' });
    installed = [];
    expect((await manager.getStatus()).providers).toMatchObject([{ id: 'sample', available: true, acceptsNewSessions: false }]);
    await expect(manager.startSession({ providerId: 'sample' })).rejects.toThrow('removed or updated');
    await manager.sendMessage({ sessionId: session.id, message: 'continue accepted session' });
    expect(provider.dispose).not.toHaveBeenCalled();
    await manager.closeSession({ sessionId: session.id });
    await manager.getStatus();
    expect(provider.dispose).toHaveBeenCalledOnce();
    await expect(manager.prepare({ providerId: 'sample' })).rejects.toThrow('Unknown agent provider');
    manager.dispose();
  });
  it('pins a provider while its accepted session creation is still pending', async () => {
    const old = new FakeProvider('sample'), replacement = new FakeProvider('sample');
    let complete!: (id: string) => void;
    old.startSession.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    let installed = [{ id: 'sample', revision: {}, load: async () => old }];
    const manager = new AgentChatManager([], vi.fn(), { installedProviders: () => installed });
    const creating = manager.startSession({ providerId: 'sample' });
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    installed = [{ id: 'sample', revision: {}, load: async () => replacement }];
    expect((await manager.getStatus()).providers).toMatchObject([{ id: 'sample', acceptsNewSessions: false }]);
    expect(old.dispose).not.toHaveBeenCalled();
    complete('old-thread');
    const accepted = await creating;
    await manager.sendMessage({ sessionId: accepted.id, message: 'still accepted' });
    expect(old.sendMessage).toHaveBeenCalled();
    expect(replacement.sendMessage).not.toHaveBeenCalled();
    await manager.closeSession({ sessionId: accepted.id });
    await manager.prepare({ providerId: 'sample' });
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(replacement.prepare).toHaveBeenCalledOnce();
    manager.dispose();
  });
  it('pins provider preparation and closing through their final await', async () => {
    const old = new FakeProvider('sample'), replacement = new FakeProvider('sample');
    let finishPrepare!: () => void, finishClose!: () => void;
    old.prepare.mockImplementation(() => new Promise(resolve => { finishPrepare = resolve; }));
    let installed = [{ id: 'sample', revision: {}, load: async () => old }];
    const manager = new AgentChatManager([], vi.fn(), { installedProviders: () => installed });
    const preparing = manager.prepare({ providerId: 'sample' });
    await vi.waitFor(() => expect(finishPrepare).toBeTypeOf('function'));
    const original = installed;
    installed = [{ id: 'sample', revision: {}, load: async () => replacement }];
    await manager.getStatus(); expect(old.dispose).not.toHaveBeenCalled();
    finishPrepare(); await preparing;
    installed = original;
    const session = await manager.startSession({ providerId: 'sample' });
    old.closeSession.mockImplementation(() => new Promise(resolve => { finishClose = resolve; }));
    const closing = manager.closeSession({ sessionId: session.id });
    await vi.waitFor(() => expect(finishClose).toBeTypeOf('function'));
    installed = [{ id: 'sample', revision: {}, load: async () => replacement }];
    await manager.getStatus(); expect(old.dispose).not.toHaveBeenCalled();
    finishClose(); await closing;
    await manager.getStatus(); expect(old.dispose).toHaveBeenCalledOnce();
    manager.dispose();
  });
  it('replaces an idle installed provider and allows restoring the accepted revision', async () => {
    const first = new FakeProvider('sample'), next = new FakeProvider('sample');
    const original = { id: 'sample', revision: {}, load: async () => first };
    let installed = [original];
    const manager = new AgentChatManager([], vi.fn(), { installedProviders: () => installed });
    const session = await manager.startSession({ providerId: 'sample' });
    installed = [{ id: 'sample', revision: {}, load: async () => next }];
    await expect(manager.prepare({ providerId: 'sample' })).rejects.toThrow('removed or updated');
    installed = [original];
    await manager.prepare({ providerId: 'sample' });
    expect(first.prepare).toHaveBeenCalledOnce();
    await manager.closeSession({ sessionId: session.id });
    installed = [{ id: 'sample', revision: {}, load: async () => next }];
    await manager.prepare({ providerId: 'sample' });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(next.prepare).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('does not call an already loaded provider after a concurrent disposal', async () => {
    const provider = new FakeProvider('codex');
    const manager = new AgentChatManager([provider], vi.fn());
    await manager.prepare({ providerId: 'codex' });
    const pending = manager.prepare({ providerId: 'codex' });
    manager.dispose();
    await expect(pending).rejects.toThrow('disposed');
    expect(provider.prepare).toHaveBeenCalledOnce();
  });

  it('loads only the requested provider and shares concurrent initialization', async () => {
    const codex = new FakeProvider('codex'),
      qoder = new FakeProvider('qoder');
    const onEvent = vi.spyOn(codex, 'onEvent');
    const loadCodex = vi.fn(async () => codex),
      loadQoder = vi.fn(async () => qoder);
    const manager = new AgentChatManager(
      [
        { id: 'codex', load: loadCodex },
        { id: 'qoder', load: loadQoder },
      ],
      vi.fn(),
    );
    expect(loadCodex).not.toHaveBeenCalled();
    await Promise.all([
      manager.prepare({ providerId: 'codex' }),
      manager.listSkills({ providerId: 'codex' }),
    ]);
    expect(loadCodex).toHaveBeenCalledOnce();
    expect(loadQoder).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledOnce();
    expect((await manager.getStatus()).providers.map(provider => provider.id)).toEqual([
      'codex',
      'qoder',
    ]);
    expect(loadQoder).toHaveBeenCalledOnce();
    manager.dispose();
    expect(codex.dispose).toHaveBeenCalledOnce();
    expect(qoder.dispose).toHaveBeenCalledOnce();
  });

  it('allows failed provider loads to retry and releases a load completed after disposal', async () => {
    const provider = new FakeProvider('codex');
    let finish!: (provider: AgentProvider) => void;
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise<AgentProvider>(resolve => {
            finish = resolve;
          }),
      );
    const manager = new AgentChatManager([{ id: 'codex', load }], vi.fn());
    await expect(manager.prepare({ providerId: 'codex' })).rejects.toThrow('unavailable');
    const pending = manager.prepare({ providerId: 'codex' });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    manager.dispose();
    finish(provider);
    await expect(pending).rejects.toThrow('disposed');
    expect(provider.prepare).not.toHaveBeenCalled();
    expect(provider.dispose).toHaveBeenCalledOnce();
  });

  it('returns the complete task result while keeping UI diagnostics bounded', async () => {
    const provider = new FakeProvider('codex');
    const emit = vi.fn();
    const manager = new AgentChatManager([provider], emit);
    const text = JSON.stringify({
      values: Array.from({ length: 200 }, (_, index) => `${index}:${'完整🙂'.repeat(1000)}`),
    });
    const task = manager.runTask({ prompt: 'Return the complete object' });
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalledOnce());
    provider.emit({
      providerSessionId: 'thread-1',
      kind: 'notification',
      method: 'item/completed',
      params: { item: { id: 'answer', type: 'agentMessage', text } },
    });
    provider.emit({
      providerSessionId: 'thread-1',
      kind: 'notification',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });
    await expect(task).resolves.toEqual({ text });
    const diagnostic = emit.mock.calls
      .map(([event]) => event)
      .find(event => event.method === 'item/completed');
    expect(diagnostic.params.item.text.length).toBeLessThan(text.length);
  });

  it('runs a temporary task and returns its final message', async () => {
    const provider = new FakeProvider('codex');
    const manager = new AgentChatManager([provider], vi.fn());
    const task = manager.runTask({
      prompt: 'Organize these tabs',
      model: 'gpt-6-luna',
      reasoningEffort: 'low',
    });

    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalledOnce());
    provider.emit({
      providerSessionId: 'thread-1',
      kind: 'notification',
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: { id: 'draft-1', type: 'agentMessage', text: 'Planning groups' },
      },
    });
    provider.emit({
      providerSessionId: 'thread-1',
      kind: 'notification',
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: { id: 'answer-1', type: 'agentMessage', text: '{"groups":[]}' },
      },
    });
    provider.emit({
      providerSessionId: 'thread-1',
      kind: 'notification',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });

    await expect(task).resolves.toEqual({ text: '{"groups":[]}' });
    expect(provider.startSession).toHaveBeenCalledWith({
      ephemeral: true,
      readOnly: true,
      modelId: 'gpt-6-luna',
    });
    expect(provider.sendMessage).toHaveBeenCalledWith('thread-1', 'Organize these tabs', [], {
      reasoningEffort: 'low',
      reasoningSummary: 'none',
    });
    expect(provider.closeSession).toHaveBeenCalledWith('thread-1');
  });

  it.each([
    { model: '' },
    { model: 'x'.repeat(201) },
    { model: 1 },
    { reasoningEffort: 'invalid' },
  ])('rejects invalid temporary task settings before creating a session: %j', async options => {
    const provider = new FakeProvider('codex');
    const manager = new AgentChatManager([provider], vi.fn());
    await expect(manager.runTask({ prompt: 'Group tabs', ...options } as any)).rejects.toThrow();
    expect(provider.startSession).not.toHaveBeenCalled();
  });

  it('rejects a temporary task that requires interaction', async () => {
    const provider = new FakeProvider('codex');
    const manager = new AgentChatManager([provider], vi.fn());
    const task = manager.runTask({ prompt: 'Plan tabs' });
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalledOnce());
    expect(provider.startSession).toHaveBeenCalledWith({ ephemeral: true, readOnly: true });
    expect(provider.sendMessage).toHaveBeenCalledWith('thread-1', 'Plan tabs', [], {
      reasoningSummary: 'none',
    });
    provider.emit({
      providerSessionId: 'thread-1',
      kind: 'request',
      method: 'item/tool/requestApproval',
      params: { requestId: 'approval-1' },
      requestId: 'approval-1',
    });
    await expect(task).rejects.toThrow('requires interactive input');
    expect(provider.interrupt).toHaveBeenCalledWith('thread-1', 'turn-1');
    expect(provider.closeSession).toHaveBeenCalledWith('thread-1');
  });

  it('tells a toolbox conversation which installed Skill to prefer', async () => {
    const provider = new FakeProvider('codex');
    const resolveToolboxAgent = vi.fn().mockReturnValue({
      toolId: 'plugin:notebook',
      skill: 'notebook-skill',
    });
    const manager = new AgentChatManager([provider], vi.fn(), { resolveToolboxAgent });

    const session = await manager.startSession({
      providerId: provider.id,
      toolboxToolId: 'plugin:notebook',
      toolboxContext: 'Notebook: Reading list',
    });

    expect(resolveToolboxAgent).toHaveBeenCalledWith('plugin:notebook');
    expect(session.toolboxToolId).toBe('plugin:notebook');
    expect(session.developerInstructions).toContain(
      'prefer the installed Skill "notebook-skill"',
    );
    expect(session.developerInstructions).toContain('<toolbox_context>');
    expect(session.developerInstructions).toContain('Notebook: Reading list');
    expect(provider.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        developerInstructions: expect.stringContaining('Notebook: Reading list'),
      }),
    );
  });

  it('only accepts toolbox context for a registered toolbox conversation', async () => {
    const provider = new FakeProvider('codex');
    const manager = new AgentChatManager([provider], vi.fn());

    await expect(
      manager.startSession({
        providerId: provider.id,
        toolboxContext: 'Notebook: Reading list',
      }),
    ).rejects.toThrow('toolboxContext requires toolboxToolId');
  });

  it('reads only SKILL.md files reported by the selected provider', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-skill-'));
    const skillPath = path.join(directory, 'SKILL.md');
    fs.writeFileSync(skillPath, '# Installed skill\n', 'utf8');
    try {
      const provider = new FakeProvider('codex');
      provider.listSkills.mockResolvedValue([
        { name: 'installed-skill', path: skillPath, scope: 'global' },
      ]);
      const manager = new AgentChatManager([provider], vi.fn());

      await expect(manager.readSkill({ providerId: 'codex', path: skillPath })).resolves.toEqual({
        path: skillPath,
        content: '# Installed skill\n',
      });
      await expect(
        manager.readSkill({ providerId: 'codex', path: path.join(directory, 'other.md') }),
      ).rejects.toThrow('not installed');

      provider.listSkills.mockResolvedValue([
        { name: 'built-in-skill', path: 'bundled', scope: 'built-in' },
      ]);
      await expect(manager.readSkill({ providerId: 'codex', path: 'bundled' })).rejects.toThrow(
        'does not expose a readable SKILL.md',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lists provider conversations with normalized metadata', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());

    await expect(manager.listSessions({ providerId: provider.id, limit: 10 })).resolves.toEqual({
      sessions: [
        {
          providerId: provider.id,
          providerSessionId: 'saved-thread',
          title: 'Saved conversation',
          cwd: process.cwd(),
          updatedAt: 123,
        },
      ],
    });
    expect(provider.listSessions).toHaveBeenCalledWith({ limit: 10 });
  });

  it('does not start provider processes while reading status', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());

    await manager.getStatus();

    expect(provider.startSession).not.toHaveBeenCalled();
    expect(provider.resumeSession).not.toHaveBeenCalled();
  });

  it('prepares only the selected provider without creating a session', async () => {
    const first = new FakeProvider('first');
    const second = new FakeProvider('second');
    const manager = new AgentChatManager([first, second], vi.fn());

    await manager.prepare({ providerId: second.id });

    expect(first.prepare).not.toHaveBeenCalled();
    expect(second.prepare).toHaveBeenCalledOnce();
    expect(second.startSession).not.toHaveBeenCalled();
  });

  it('starts a provider session and tracks turn lifecycle events', async () => {
    const provider = new FakeProvider();
    const emit = vi.fn();
    const manager = new AgentChatManager([provider], emit);

    const workspace = fs.realpathSync.native(process.cwd());
    const session = await manager.startSession({ providerId: provider.id, cwd: workspace });
    await manager.sendMessage({ sessionId: session.id, message: 'hello' });

    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'turn/started',
      params: { turn: { id: 'turn-1' } },
    });
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });

    const status = await manager.getStatus();
    expect(provider.startSession).toHaveBeenCalledWith({
      cwd: workspace,
      developerInstructions: expect.stringContaining('not as a filesystem access boundary'),
    });
    expect(session.developerInstructions).toContain(`"referenceDirectory": "${workspace}"`);
    expect(provider.sendMessage).toHaveBeenCalledWith('thread-1', 'hello');
    expect(status.sessions[0]).toMatchObject({ status: 'idle', providerSessionId: 'thread-1' });
    expect(emit.mock.calls.map(call => call[0].method)).toEqual([
      'session/started',
      'chat/userMessage',
      'turn/started',
      'turn/completed',
    ]);
  });

  it('tracks configured and rerouted models without retaining a completed turn override', async () => {
    const provider = new FakeProvider();
    provider.getSessionModel.mockReturnValue({ id: 'configured-model' });
    const manager = new AgentChatManager([provider], vi.fn());

    const session = await manager.startSession({ providerId: provider.id });
    expect(session.model).toEqual({ id: 'configured-model' });

    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'turn/started',
      params: { turn: { id: 'turn-1' } },
    });
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'session/activeModel/updated',
      params: { model: { id: 'rerouted-model' } },
    });
    expect((await manager.getStatus()).sessions[0]?.activeModel).toEqual({
      id: 'rerouted-model',
    });

    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'session/model/updated',
      params: { model: { id: 'new-configured-model' } },
    });
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });

    const completedSession = (await manager.getStatus()).sessions[0];
    expect(completedSession).toMatchObject({
      model: { id: 'new-configured-model' },
    });
    expect(completedSession).not.toHaveProperty('activeModel');
  });

  it('keeps provider context out of the displayed message event', async () => {
    const provider = new FakeProvider();
    const emit = vi.fn();
    const manager = new AgentChatManager([provider], emit);
    const session = await manager.startSession({ providerId: provider.id });
    const message = 'Inspect this button\n\n<selected_page_element>{}</selected_page_element>';

    await manager.sendMessage({
      sessionId: session.id,
      message,
      displayMessage: 'Inspect this button',
      clientMessageId: 'client-message-1',
    });

    expect(provider.sendMessage).toHaveBeenCalledWith('thread-1', message);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'client-message-1',
        method: 'chat/userMessage',
        params: { text: 'Inspect this button' },
      }),
    );
    expect(manager.getEvents({ sessionId: session.id }).events).toContainEqual(
      expect.objectContaining({
        id: 'client-message-1',
        params: { text: 'Inspect this button' },
      }),
    );
  });

  it('accepts an image-only message and forwards sanitized image input', async () => {
    const provider = new FakeProvider();
    const emit = vi.fn();
    const manager = new AgentChatManager([provider], emit);
    const session = await manager.startSession({ providerId: provider.id });

    await manager.sendMessage({
      sessionId: session.id,
      message: '',
      displayMessage: '',
      images: [{ data: 'AQID', mimeType: 'image/png', name: 'screenshot.png' }],
    });

    expect(provider.sendMessage).toHaveBeenCalledWith('thread-1', '', [
      { data: 'AQID', mimeType: 'image/png', name: 'screenshot.png' },
    ]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'chat/userMessage',
        params: {
          text: '',
          imageCount: 1,
        },
      }),
    );
  });

  it('rejects invalid workspaces before starting a provider session', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());

    await expect(
      manager.startSession({ providerId: provider.id, cwd: 'relative/workspace' }),
    ).rejects.toThrow('absolute path');
    expect(provider.startSession).not.toHaveBeenCalled();
  });

  it('does not change the reference directory of an existing provider session', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());
    const workspace = fs.realpathSync.native(process.cwd());

    await manager.startSession({
      providerId: provider.id,
      providerSessionId: 'saved-thread',
    });

    await expect(
      manager.startSession({
        providerId: provider.id,
        providerSessionId: 'saved-thread',
        cwd: workspace,
      }),
    ).rejects.toThrow('reference directory does not match the existing agent session');
    expect(provider.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('reuses an already resumed provider thread', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());

    const first = await manager.startSession({
      providerId: provider.id,
      providerSessionId: 'saved-thread',
    });
    const second = await manager.startSession({
      providerId: provider.id,
      providerSessionId: 'saved-thread',
    });

    expect(second.id).toBe(first.id);
    expect(provider.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('replays provider history after resuming a saved thread', async () => {
    const provider = new FakeProvider();
    provider.resumeSession.mockResolvedValueOnce({
      providerSessionId: 'saved-thread',
      history: [
        {
          kind: 'lifecycle',
          method: 'chat/userMessage',
          params: { text: 'Continue debugging' },
          timestamp: 123,
        },
      ],
    });
    const emit = vi.fn();
    const manager = new AgentChatManager([provider], emit);

    const session = await manager.startSession({
      providerId: provider.id,
      providerSessionId: 'saved-thread',
    });

    expect(manager.getEvents({ sessionId: session.id }).events).toContainEqual(
      expect.objectContaining({
        method: 'chat/userMessage',
        params: { text: 'Continue debugging' },
        timestamp: 123,
      }),
    );
    expect(emit.mock.calls.map(call => call[0].method)).toEqual([
      'chat/userMessage',
      'session/resumed',
    ]);
  });

  it('replaces replayed history when refreshing a resumed thread', async () => {
    const provider = new FakeProvider();
    provider.resumeSession
      .mockResolvedValueOnce({
        providerSessionId: 'saved-thread',
        historyComplete: true,
        history: [
          {
            kind: 'lifecycle',
            method: 'chat/userMessage',
            params: { text: 'Old history' },
          },
        ],
      })
      .mockResolvedValueOnce({
        providerSessionId: 'saved-thread',
        historyComplete: true,
        history: [
          {
            kind: 'lifecycle',
            method: 'chat/userMessage',
            params: { text: 'Updated externally' },
          },
        ],
      });
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({
      providerId: provider.id,
      providerSessionId: 'saved-thread',
    });
    for (const delta of ['first', 'second']) {
      provider.emit({
        providerSessionId: session.providerSessionId,
        kind: 'notification',
        method: 'item/agentMessage/delta',
        params: { itemId: 'streamed-message', delta },
      });
    }
    expect(manager.getEvents({ sessionId: session.id }).retention?.compactedEventCount).toBe(1);

    const refreshed = await manager.refreshSession({ sessionId: session.id });

    expect(provider.resumeSession).toHaveBeenCalledTimes(2);
    expect(refreshed.session).toMatchObject({
      id: session.id,
      providerSessionId: 'saved-thread',
      status: 'idle',
    });
    expect(refreshed.events.map(event => event.method)).toEqual([
      'chat/userMessage',
      'session/refreshed',
    ]);
    expect(refreshed.events[0]?.params).toEqual({ text: 'Updated externally' });
    expect(refreshed.retention?.compactedEventCount).toBe(0);
  });

  it('preserves buffered events when a provider cannot return complete history', async () => {
    const provider = new FakeProvider();
    provider.resumeSession
      .mockResolvedValueOnce({
        providerSessionId: 'saved-thread',
        history: [
          {
            kind: 'lifecycle',
            method: 'chat/userMessage',
            params: { text: 'Keep this history' },
          },
        ],
      })
      .mockResolvedValueOnce({ providerSessionId: 'saved-thread' });
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({
      providerId: provider.id,
      providerSessionId: 'saved-thread',
    });

    const refreshed = await manager.refreshSession({ sessionId: session.id });

    expect(refreshed.events.map(event => event.method)).toEqual([
      'chat/userMessage',
      'session/resumed',
      'session/refreshed',
    ]);
    expect(refreshed.events[0]?.params).toEqual({ text: 'Keep this history' });
  });

  it('rejects unsupported image input before changing session state', async () => {
    const provider = new FakeProvider();
    provider.validateMessageInput.mockRejectedValueOnce(new Error('Images are unsupported'));
    const emit = vi.fn();
    const manager = new AgentChatManager([provider], emit);
    const session = await manager.startSession({ providerId: provider.id });

    await expect(
      manager.sendMessage({
        sessionId: session.id,
        message: '',
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow('Images are unsupported');

    expect(provider.sendMessage).not.toHaveBeenCalled();
    expect((await manager.getStatus()).sessions[0]?.status).toBe('idle');
    expect(emit.mock.calls.map(call => call[0].method)).toEqual(['session/started']);
  });

  it('binds a session to its browser tab and injects Mearl skill instructions', async () => {
    const provider = new FakeProvider('codex');
    const manager = new AgentChatManager([provider], vi.fn());

    const session = await manager.startSession({
      providerId: provider.id,
      tabId: 321,
      initialPageUrl:
        'https://user:password@example.com/checkout?step=confirm&access_token=query-secret',
      initialPageTitle: 'Checkout',
    });

    expect(session.tabId).toBe(321);
    expect(session.initialPageUrl).toBe(
      'https://example.com/checkout?step=confirm&access_token=%5BREDACTED%5D',
    );
    expect(session.initialPageUrl).not.toContain('query-secret');
    expect(session.initialPageUrl).not.toContain('password');
    expect(session.initialPageTitle).toBe('Checkout');
    expect(session.developerInstructions).toContain('{"tabId": 321}');
    expect(session.developerInstructions).toContain(
      '"url": "https://example.com/checkout?step=confirm&access_token=%5BREDACTED%5D"',
    );
    expect(session.developerInstructions).toContain('"title": "Checkout"');
    expect(provider.startSession).toHaveBeenCalledWith({
      developerInstructions: expect.stringContaining('use the mearl skill'),
    });
    expect(provider.startSession.mock.calls[0]?.[0].developerInstructions).toContain(
      '{"tabId": 321}',
    );
    expect(provider.startSession.mock.calls[0]?.[0].developerInstructions).toContain(
      `save it under ${JSON.stringify(path.join(os.homedir(), '.mearl', 'visualizations'))}`,
    );
  });

  it('forwards the ephemeral setting when starting a new provider session', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());

    const session = await manager.startSession({
      providerId: provider.id,
      tabId: 321,
      ephemeral: true,
    });

    expect(session.ephemeral).toBe(true);
    expect(provider.startSession).toHaveBeenCalledWith({
      developerInstructions: expect.stringContaining('use the mearl skill'),
      ephemeral: true,
    });
  });

  it('opens persistent provider sessions in their native app', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({ providerId: provider.id, ephemeral: false });

    await manager.openSession({ sessionId: session.id });

    expect(provider.openSession).toHaveBeenCalledWith('thread-1');
  });

  it('does not open temporary provider sessions in their native app', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({ providerId: provider.id, ephemeral: true });

    await expect(manager.openSession({ sessionId: session.id })).rejects.toThrow(
      'Temporary Codex conversations cannot be opened in Codex App',
    );
    expect(provider.openSession).not.toHaveBeenCalled();
  });

  it('opens a selected directory in Codex App without creating a session', async () => {
    const provider = new FakeProvider('codex');
    const manager = new AgentChatManager([provider], vi.fn());
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-codex-workspace-'));
    try {
      await manager.openWorkspace({ cwd: directory });
      expect(provider.openWorkspace).toHaveBeenCalledExactlyOnceWith(
        fs.realpathSync.native(directory),
      );
      expect(provider.startSession).not.toHaveBeenCalled();
      await expect(manager.openWorkspace({ cwd: path.join(directory, 'missing') })).rejects.toThrow(
        'does not exist',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reapplies the bound tab instructions when resuming a provider thread', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());

    const session = await manager.startSession({
      providerId: provider.id,
      providerSessionId: 'saved-thread',
      tabId: 654,
      initialPageUrl: 'https://example.com/orders/42',
      initialPageTitle: 'Order 42',
    });

    expect(session.tabId).toBe(654);
    expect(session.initialPageUrl).toBe('https://example.com/orders/42');
    expect(session.initialPageTitle).toBe('Order 42');
    expect(session.developerInstructions).toContain('{"tabId": 654}');
    expect(session.developerInstructions).toContain('"url": "https://example.com/orders/42"');
    expect(provider.resumeSession).toHaveBeenCalledWith('saved-thread', {
      developerInstructions: expect.stringContaining('{"tabId": 654}'),
    });
  });

  it('rejects an invalid browser tab id before starting the provider', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());

    await expect(manager.startSession({ providerId: provider.id, tabId: -1 })).rejects.toThrow(
      'tabId must be a non-negative integer',
    );
    expect(provider.startSession).not.toHaveBeenCalled();
  });

  it('rejects invalid initial page metadata before starting the provider', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());

    await expect(
      manager.startSession({
        providerId: provider.id,
        tabId: 1,
        initialPageTitle: 42 as unknown as string,
      }),
    ).rejects.toThrow('initialPageTitle must be a string');
    expect(provider.startSession).not.toHaveBeenCalled();
  });

  it('forwards provider requests and their responses', async () => {
    const provider = new FakeProvider();
    const emit = vi.fn();
    const manager = new AgentChatManager([provider], emit);
    const session = await manager.startSession({ providerId: provider.id });

    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'request',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'pnpm test' },
      requestId: 42,
    });
    manager.respondToRequest({
      sessionId: session.id,
      requestId: 42,
      result: { decision: 'accept' },
    });

    const status = await manager.getStatus();
    expect(status.sessions[0]?.status).toBe('running');
    expect(provider.respondToRequest).toHaveBeenCalledWith(42, { decision: 'accept' });
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'request',
      requestId: 42,
      method: 'item/commandExecution/requestApproval',
    });
    expect(() =>
      manager.respondToRequest({
        sessionId: session.id,
        requestId: 42,
        result: { decision: 'accept' },
      }),
    ).toThrow('Unknown agent request');
  });

  it('does not restore an active turn after an early completion event', async () => {
    const provider = new FakeProvider();
    let finishStart: ((result: { turnId: string }) => void) | undefined;
    provider.sendMessage.mockImplementation(
      () =>
        new Promise(resolve => {
          finishStart = resolve;
        }),
    );
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({ providerId: provider.id });

    const sendPromise = manager.sendMessage({ sessionId: session.id, message: 'hello' });
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'turn/completed',
      params: { turn: { id: 'turn-early', status: 'failed' } },
    });
    finishStart?.({ turnId: 'turn-early' });
    await sendPromise;

    const restoredSession = (await manager.getStatus()).sessions[0];
    expect(restoredSession?.status).toBe('idle');
    expect(restoredSession?.activeTurnId).toBeUndefined();
  });

  it('keeps a provider exit terminal after a late turn completion', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({ providerId: provider.id });

    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'request',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'pnpm test' },
      requestId: 42,
    });
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'error',
      method: 'provider/exited',
      params: { message: 'provider crashed' },
    });
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'failed' } },
    });

    expect((await manager.getStatus()).sessions[0]?.status).toBe('error');
    expect(() =>
      manager.respondToRequest({
        sessionId: session.id,
        requestId: 42,
        result: { decision: 'accept' },
      }),
    ).toThrow('Unknown agent request');
  });

  it('replays bounded session events and releases closed sessions', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({ providerId: provider.id });

    await manager.sendMessage({
      sessionId: session.id,
      message: 'hello',
      clientMessageId: 'client-message-1',
    });

    expect(manager.getEvents({ sessionId: session.id })).toMatchObject({
      retention: {
        truncated: false,
        maxEvents: 1000,
        maxBytes: 2048 * 1024,
        maxPageBytes: 512 * 1024,
      },
      events: expect.arrayContaining([
        expect.objectContaining({ id: 'client-message-1', method: 'chat/userMessage' }),
      ]),
    });

    for (let index = 0; index < 1010; index += 1) {
      provider.emit({
        providerSessionId: session.providerSessionId,
        kind: 'notification',
        method: 'tool/progress',
        params: { index },
      });
    }
    expect(manager.getEvents({ sessionId: session.id })).toMatchObject({
      retention: {
        truncated: true,
        maxEvents: 1000,
        maxBytes: 2048 * 1024,
        maxPageBytes: 512 * 1024,
      },
      events: expect.any(Array),
    });
    expect(manager.getEvents({ sessionId: session.id }).events).toHaveLength(1000);

    await manager.closeSession({ sessionId: session.id });
    expect(provider.closeSession).toHaveBeenCalledWith(session.providerSessionId);
    expect((await manager.getStatus()).sessions).toEqual([]);
    expect(() => manager.getEvents({ sessionId: session.id })).toThrow('Unknown chat session');
  });

  it('retains the latest runtime settings after replay truncation', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({ providerId: provider.id });

    for (const approvalPolicy of ['on-request', 'never']) {
      provider.emit({
        providerSessionId: session.providerSessionId,
        kind: 'notification',
        method: 'thread/settings/updated',
        params: {
          threadSettings: {
            approvalPolicy,
            activePermissionProfile: { id: 'mearl_browser_read_only', extends: ':read-only' },
          },
        },
      });
    }
    for (let index = 0; index < 1010; index += 1) {
      provider.emit({
        providerSessionId: session.providerSessionId,
        kind: 'notification',
        method: 'tool/progress',
        params: { index },
      });
    }

    const replay = manager.getEvents({ sessionId: session.id });
    expect(replay.retention).toMatchObject({
      truncated: true,
      compactedEventCount: 1,
    });
    expect(replay.events).toHaveLength(1000);
    expect(replay.events.filter(event => event.method === 'thread/settings/updated')).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          threadSettings: expect.objectContaining({ approvalPolicy: 'never' }),
        }),
      }),
    ]);
  });

  it('pages a 2 MiB replay buffer below the Native Messaging response boundary', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({ providerId: provider.id });
    const payload = 'x'.repeat(300 * 1024);

    for (let index = 0; index < 6; index += 1) {
      provider.emit({
        providerSessionId: session.providerSessionId,
        kind: 'notification',
        method: 'tool/progress',
        params: { index, payload },
      });
    }

    const firstPage = manager.getEvents({ sessionId: session.id });
    expect(firstPage.retention).toMatchObject({
      truncated: false,
      maxBytes: 2048 * 1024,
      maxPageBytes: 512 * 1024,
    });
    expect(firstPage.retention?.retainedBytes).toBeGreaterThan(1024 * 1024);
    expect(firstPage.retention?.retainedBytes).toBeLessThanOrEqual(2048 * 1024);
    expect(firstPage.nextCursor).toBeTypeOf('number');

    const pages = [firstPage];
    let cursor = firstPage.nextCursor;
    while (cursor !== undefined) {
      const page = manager.getEvents({ sessionId: session.id, cursor });
      pages.push(page);
      cursor = page.nextCursor;
    }
    for (const page of pages) {
      expect(
        Buffer.byteLength(JSON.stringify({ id: 'request_1', success: true, data: page }), 'utf8'),
      ).toBeLessThan(1024 * 1024);
    }
    expect(
      pages
        .reverse()
        .flatMap(page => page.events)
        .filter(event => event.method === 'tool/progress')
        .map(event => (event.params as { index: number }).index),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('compacts completed streaming items while retaining their lifecycle events', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({ providerId: provider.id });

    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'item/started',
      params: {
        turnId: 'turn-1',
        item: { id: 'reasoning-1', type: 'reasoning', summary: [] },
      },
    });
    for (const delta of ['先检查', '页面，', '再执行。']) {
      provider.emit({
        providerSessionId: session.providerSessionId,
        kind: 'notification',
        method: 'item/reasoning/summaryTextDelta',
        params: { turnId: 'turn-1', itemId: 'reasoning-1', delta },
      });
    }
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'item/started',
      params: {
        turnId: 'turn-1',
        item: { id: 'tool-1', type: 'mcpToolCall', status: 'inProgress' },
      },
    });
    for (const message of ['正在调用', '等待结果']) {
      provider.emit({
        providerSessionId: session.providerSessionId,
        kind: 'notification',
        method: 'item/mcpToolCall/progress',
        params: { turnId: 'turn-1', itemId: 'tool-1', message },
      });
    }

    const inFlightReplay = manager.getEvents({ sessionId: session.id });
    expect(inFlightReplay.retention).toMatchObject({
      truncated: false,
      compactedEventCount: 3,
    });
    expect(
      inFlightReplay.events.find(event => event.method === 'item/reasoning/summaryTextDelta')
        ?.params,
    ).toMatchObject({ delta: '先检查页面，再执行。' });
    expect(
      inFlightReplay.events.find(event => event.method === 'item/mcpToolCall/progress')?.params,
    ).toMatchObject({ message: '等待结果' });

    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: { id: 'reasoning-1', type: 'reasoning', summary: ['先检查页面，再执行。'] },
      },
    });
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: { id: 'tool-1', type: 'mcpToolCall', status: 'completed' },
      },
    });

    const replay = manager.getEvents({ sessionId: session.id });
    expect(replay.retention).toMatchObject({
      truncated: false,
      compactedEventCount: 5,
    });
    expect(
      replay.events
        .filter(event => event.method === 'item/started' || event.method === 'item/completed')
        .map(event => event.method),
    ).toEqual(['item/started', 'item/started', 'item/completed', 'item/completed']);
  });

  it('preserves early tool events across a large completed reasoning stream', async () => {
    const provider = new FakeProvider();
    const manager = new AgentChatManager([provider], vi.fn());
    const session = await manager.startSession({ providerId: provider.id });

    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'item/started',
      params: {
        turnId: 'turn-1',
        item: { id: 'tool-early', type: 'mcpToolCall', status: 'inProgress' },
      },
    });
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: { id: 'tool-early', type: 'mcpToolCall', status: 'completed' },
      },
    });
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'item/started',
      params: {
        turnId: 'turn-1',
        item: { id: 'reasoning-large', type: 'reasoning', summary: [] },
      },
    });
    for (let index = 0; index < 1_200; index += 1) {
      provider.emit({
        providerSessionId: session.providerSessionId,
        kind: 'notification',
        method: 'item/reasoning/summaryTextDelta',
        params: { turnId: 'turn-1', itemId: 'reasoning-large', delta: 'x' },
      });
    }
    provider.emit({
      providerSessionId: session.providerSessionId,
      kind: 'notification',
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: { id: 'reasoning-large', type: 'reasoning', summary: ['x'.repeat(1_200)] },
      },
    });

    const replay = manager.getEvents({ sessionId: session.id });
    expect(replay.retention).toMatchObject({
      truncated: false,
      compactedEventCount: 1_200,
    });
    expect(
      replay.events
        .filter(event => {
          const params = event.params as { item?: { id?: string } };
          return params.item?.id === 'tool-early';
        })
        .map(event => event.method),
    ).toEqual(['item/started', 'item/completed']);
  });
});
