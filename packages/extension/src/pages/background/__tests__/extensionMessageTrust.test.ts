import { describe, expect, it } from 'vitest';
import { isExtensionUiSender } from '../extensionMessageTrust';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

describe('extension UI message boundary', () => {
  it.each([
    'src/pages/popup/index.html',
    'plugin/index.html#notebook',
    'src/pages/sidepanel/index.html',
  ])('accepts an extension page at %s', path => {
    expect(
      isExtensionUiSender(
        { id: extensionId, url: `chrome-extension://${extensionId}/${path}` },
        extensionId,
      ),
    ).toBe(true);
  });

  it.each([
    `https://example.com/page`,
    `https://example.com/?url=chrome-extension://${extensionId}/plugin/index.html`,
    `chrome-extension://${extensionId}.example.com/plugin/index.html`,
    `chrome-extension://${extensionId}@example.com/plugin/index.html`,
    `chrome-extension://another-extension/plugin/index.html`,
    'about:blank',
    undefined,
  ])('rejects content-script or foreign sender URLs: %s', url => {
    expect(isExtensionUiSender({ id: extensionId, url }, extensionId)).toBe(false);
  });

  it('requires the matching extension ID even for an extension URL', () => {
    const url = `chrome-extension://${extensionId}/plugin/index.html`;
    expect(isExtensionUiSender({ url }, extensionId)).toBe(false);
    expect(isExtensionUiSender({ id: 'another-extension', url }, extensionId)).toBe(false);
    expect(isExtensionUiSender({ id: '', url: 'chrome-extension:///plugin/index.html' }, '')).toBe(
      false,
    );
  });
});
