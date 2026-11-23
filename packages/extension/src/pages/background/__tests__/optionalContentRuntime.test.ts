import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeScript = vi.hoisted(() => vi.fn());
const getAllFrames = vi.hoisted(() => vi.fn());

import {
  ensureOptionalContentRuntime,
  ensureOptionalContentRuntimeForFrames,
} from '../optionalContentRuntime';

describe('optionalContentRuntime', () => {
  beforeEach(() => {
    executeScript.mockReset();
    getAllFrames.mockReset();
    chrome.scripting = { executeScript } as unknown as typeof chrome.scripting;
    chrome.webNavigation = { getAllFrames } as unknown as typeof chrome.webNavigation;
  });

  it('reuses ready frames and injects only missing runtimes', async () => {
    const ready = new Set([0]);
    executeScript.mockImplementation(({ target, files }) => {
      const frameId = target.frameIds[0];
      if (files) {
        ready.add(frameId);
        return Promise.resolve([{ frameId }]);
      }
      return Promise.resolve([{ frameId, result: ready.has(frameId) }]);
    });

    await expect(
      ensureOptionalContentRuntimeForFrames(9, [0, 7, 7], '__runtime', 'runtime.js'),
    ).resolves.toEqual([0, 7]);

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 9, frameIds: [7] },
      world: 'ISOLATED',
      files: ['runtime.js'],
    });
    expect(executeScript).not.toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 9, frameIds: [0] }, files: ['runtime.js'] }),
    );
  });

  it('falls back to the top frame when frame enumeration is unavailable', async () => {
    getAllFrames.mockImplementation((_details, callback) => callback(undefined));
    executeScript.mockResolvedValue([{ frameId: 0, result: true }]);

    await expect(ensureOptionalContentRuntime(9, '__runtime', 'runtime.js')).resolves.toEqual([0]);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 9, frameIds: [0] }, world: 'ISOLATED' }),
    );
  });

  it('omits frames where injection fails', async () => {
    executeScript.mockImplementation(({ files }) =>
      files
        ? Promise.reject(new Error('blocked'))
        : Promise.resolve([{ frameId: 0, result: false }]),
    );

    await expect(
      ensureOptionalContentRuntimeForFrames(9, [0], '__runtime', 'runtime.js'),
    ).resolves.toEqual([]);
  });
});
