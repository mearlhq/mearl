import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFrameVisualRuntime } from '../frameVisualRuntime';

describe('frameVisualRuntime', () => {
  const addListener = vi.fn();
  const sendMessage = vi.fn();

  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete (window as typeof window & Record<string, unknown>).__mearlFrameVisualRuntime;
    addListener.mockReset();
    sendMessage.mockReset().mockResolvedValue(undefined);
    chrome.runtime.onMessage.addListener = addListener;
    chrome.runtime.sendMessage = sendMessage;
  });

  it('installs once and handles SPM highlighting in the current frame document', () => {
    const target = document.createElement('button');
    target.setAttribute('data-spm', 'card');
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);

    installFrameVisualRuntime();
    installFrameVisualRuntime();

    expect(addListener).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      source: 'mearl-content-script',
      type: 'FRAME_VISUAL_RUNTIME_READY',
    });
    const listener = addListener.mock.calls[0]![0];
    const sendResponse = vi.fn();
    expect(listener({ action: 'highlightSpm', spm: '181.1.card' }, {}, sendResponse)).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ found: 1 });
    expect(document.querySelectorAll('[data-mtop-spm-hotzone]')).toHaveLength(1);

    listener({ action: 'clearSpmHighlight' }, {}, vi.fn());
  });

  it('reports the matching frame when preparing an Elements inspection', () => {
    const target = document.createElement('div');
    target.setAttribute('data-spm', 'list');
    document.body.appendChild(target);

    installFrameVisualRuntime();
    const listener = addListener.mock.calls[0]![0];
    const sendResponse = vi.fn();
    listener({ action: 'inspectSpm', spm: '181.1.list' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ found: 1 });
    expect(target).toHaveAttribute('data-mtop-inspect', '1');
  });

  it('waits for the document body before reporting the frame as ready', () => {
    document.body.remove();

    installFrameVisualRuntime();

    expect(sendMessage).not.toHaveBeenCalled();

    document.documentElement.appendChild(document.createElement('body'));
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
