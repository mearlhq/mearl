import { afterEach, describe, expect, it, vi } from 'vitest';

const values: Record<string, unknown> = {};
afterEach(() => {
  Object.keys(values).forEach(key => delete values[key]);
  vi.resetModules();
});

function storage() {
  chrome.storage.session = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (next: object) => Object.assign(values, next)),
  } as any;
}

describe('environment mutation revisions', () => {
  it('serializes and persists coordinated writes independently for each component', async () => {
    storage();
    const revisions = await import('../environmentRevisions');
    await Promise.all([
      revisions.markEnvironmentMutation(7, 'timezone'),
      revisions.markEnvironmentMutation(7, 'timezone'),
      revisions.markEnvironmentMutation(7, 'device'),
    ]);
    expect(await revisions.getEnvironmentRevision(7, 'timezone')).toBe(2);
    expect(await revisions.getEnvironmentRevision(7, 'device')).toBe(1);
    vi.resetModules();
    expect(await (await import('../environmentRevisions')).getEnvironmentRevision(7, 'timezone')).toBe(2);
  });

  it('keeps ordinary effects available when storage fails, while refusing cooperative recovery', async () => {
    storage();
    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(new Error('quota'));
    const revisions = await import('../environmentRevisions');
    await expect(revisions.markEnvironmentMutation(7, 'timezone')).resolves.toBeUndefined();
    await expect(revisions.getEnvironmentRevision(7, 'timezone')).rejects.toThrow('ENVIRONMENT_REVISION_UNAVAILABLE');
  });
});
