import { describe, expect, it } from 'vitest';
import { extractI18nKeysFromSource } from '../clean-i18n.js';

describe('clean-i18n', () => {
  it('extracts literal keys from multiline and parameterized calls', () => {
    const source = `
      t(
        'agentChatImageTooLarge',
        String(AGENT_CHAT_MAX_IMAGE_BYTES / 1024 / 1024),
      );
      t /* keep comments */ ("doubleQuotedKey");
      t<string>('genericCallKey');
      chrome.i18n.getMessage(
        'chromeMessageKey',
        ['replacement'],
      );
      helper.getMessage(\`templateLiteralKey\`);
      i18nMessage('contentScriptMessageKey');
      t(dynamicKey);
      t(\`dynamic-\${suffix}\`);
    `;

    expect([...extractI18nKeysFromSource(source, 'fixture.tsx')]).toEqual([
      'agentChatImageTooLarge',
      'doubleQuotedKey',
      'genericCallKey',
      'chromeMessageKey',
      'templateLiteralKey',
      'contentScriptMessageKey',
    ]);
  });
});
