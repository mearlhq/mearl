import { describe, expect, it } from 'vitest';
import {
  buildGetSelectedElementScript,
  extractSelectedElementEvalError,
  formatInspectedWindowEvalException,
} from '../selectedElementEval';

describe('selectedElementEval', () => {
  it('builds a script that checks collector availability before calling it', () => {
    const script = buildGetSelectedElementScript(false);

    expect(script).toContain('const el = $0');
    expect(script).toContain("typeof collector !== 'function'");
    expect(script).toContain('return collector(el, false)');
  });

  it('extracts a readable missing collector error with host context', () => {
    const message = extractSelectedElementEvalError({
      __mearlError: {
        message: 'Mearl content script is not available on this page.',
        host: 'example.com',
      },
    });

    expect(message).toBe(
      'Mearl content script is not available on this page. Current host: example.com.',
    );
  });

  it('formats inspectedWindow eval exception objects instead of returning [object Object]', () => {
    const message = formatInspectedWindowEvalException({
      code: 'E_PROTOCOLERROR',
      details: { reason: 'not allowed' },
    });

    expect(message).toBe('{"reason":"not allowed"}');
  });
});
