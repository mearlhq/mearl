import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
  DISABLED_BUILTIN_ORIGINS_STORAGE_KEY,
  PROXY_PERMISSION_STORAGE_KEY,
} from '../../../../shared/proxyPermissions';
import AgentPermissionsSection from '../AgentPermissionsSection';

describe('AgentPermissionsSection', () => {
  const storage: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];
    storage[PROXY_PERMISSION_STORAGE_KEY] = ['*://localhost/*', '*://*.example.com/*'];
    storage[DISABLED_BUILTIN_ORIGINS_STORAGE_KEY] = [];
    storage[AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY] = false;

    chrome.storage.sync = {
      get: vi.fn((keys: string[], callback: (items: Record<string, unknown>) => void) => {
        callback(Object.fromEntries(keys.map(key => [key, storage[key]])));
      }),
      set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
        Object.assign(storage, items);
        callback?.();
      }),
    } as unknown as typeof chrome.storage.sync;
    chrome.runtime.sendMessage = vi.fn(async () => ({ success: true, data: { presetId: 'team', revision: 'fixture', origins: [], pending: [] } })) as any;
    chrome.permissions = {
      request: vi.fn((_permissions, callback) => callback(true)),
    } as unknown as typeof chrome.permissions;
  });

  it('shows the configured domain list when all-domain access is disabled', async () => {
    render(<AgentPermissionsSection />);

    expect(await screen.findByPlaceholderText('agentPermissionsInputPlaceholder')).toBeVisible();
    expect(screen.getByText('localhost')).toBeVisible();
  });

  it('hides the configured domain list when all-domain access is enabled', async () => {
    storage[AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY] = true;
    render(<AgentPermissionsSection />);

    const toggle = await screen.findByRole('button', { name: 'agentPermissionsAllDomains' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.queryByPlaceholderText('agentPermissionsInputPlaceholder'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('localhost')).not.toBeInTheDocument();
  });

  it('requests browser permission before enabling access to all domains', async () => {
    render(<AgentPermissionsSection />);

    const toggle = await screen.findByRole('button', { name: 'agentPermissionsAllDomains' });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'));
    expect(chrome.permissions.request).toHaveBeenCalledWith(
      { origins: ['<all_urls>'] },
      expect.any(Function),
    );
    expect(storage[AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY]).toBe(true);
    expect(
      screen.queryByPlaceholderText('agentPermissionsInputPlaceholder'),
    ).not.toBeInTheDocument();
  });
  it('keeps preset authorization pending after refusal and grants only displayed scopes on retry', async () => {
    const origin = 'https://accounts.example.test/*';
    chrome.runtime.sendMessage = vi.fn(async (message: any) => {
      if (message.data.operation === 'authorizePreset') {
        expect(message.data).toMatchObject({ presetId: 'team', revision: 'fixture' });
        storage[PROXY_PERMISSION_STORAGE_KEY] = [...(storage[PROXY_PERMISSION_STORAGE_KEY] as string[]), '*://accounts.example.test/*'];
      }
      return { success: true, data: { presetId: 'team', revision: 'fixture', origins: [origin], pending: (storage[PROXY_PERMISSION_STORAGE_KEY] as string[]).includes('*://accounts.example.test/*') ? [] : [origin] } };
    }) as any;
    chrome.permissions.contains = vi.fn(async () => true);
    vi.mocked(chrome.permissions.request).mockImplementationOnce((_value, callback: any) => callback(false));
    render(<AgentPermissionsSection />);
    const grant = await screen.findByRole('button', { name: 'presetPermissionsGrant' });
    fireEvent.click(grant);
    await waitFor(() => expect(grant).not.toBeDisabled());
    expect(storage[PROXY_PERMISSION_STORAGE_KEY]).not.toContain('*://accounts.example.test/*');
    fireEvent.click(grant);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'presetPermissionsGrant' })).not.toBeInTheDocument());
    expect(chrome.permissions.request).toHaveBeenLastCalledWith({ origins: [origin] }, expect.any(Function));
    expect(storage[PROXY_PERMISSION_STORAGE_KEY]).toContain('*://accounts.example.test/*');
    expect(storage[AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY]).toBe(false);
  });

});
