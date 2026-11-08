import { describe, expect, it, vi } from 'vitest';
import { CLOUD_SERVER_MODE_ENV, resolveCloudServerMode } from '../mode.js';

describe('cloud server mode', () => {
  it('persists an explicit Qoder mode marker from setup', () => {
    const writeText = vi.fn();

    expect(
      resolveCloudServerMode(
        { [CLOUD_SERVER_MODE_ENV]: 'qoder' },
        { modeFile: '/tmp/cloud-mode.json', writeText },
      ),
    ).toBe('qoder');
    expect(writeText).toHaveBeenCalledWith('/tmp/cloud-mode.json', '{"mode":"qoder"}\n');
  });

  it('reuses the stored mode when no setup marker is present', () => {
    expect(resolveCloudServerMode({}, { readText: () => '{"mode":"qoder"}' })).toBe('qoder');
  });

  it('defaults to WebSocket mode for missing or malformed state', () => {
    expect(resolveCloudServerMode({}, { readText: () => '{invalid' })).toBe('websocket');
  });

  it('allows regular cloud setup to switch back to WebSocket mode', () => {
    const removeFile = vi.fn();

    expect(
      resolveCloudServerMode(
        { [CLOUD_SERVER_MODE_ENV]: 'websocket' },
        { readText: () => '{"mode":"qoder"}', removeFile },
      ),
    ).toBe('websocket');
    expect(removeFile).toHaveBeenCalledOnce();
  });
});
