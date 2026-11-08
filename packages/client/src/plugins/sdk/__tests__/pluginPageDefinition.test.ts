import { describe, expect, it } from 'vitest';
import { normalizePluginPageRuntime } from '../pluginPageDefinition.js';

const runtime = (code: string) => ({ version: 1, matches: ['https://example.test/*'], code });

describe('page runtime declarations', () => {
  it('compiles page expressions without evaluating plugin code in the host', () => {
    const declaration = runtime('(() => { throw new Error("must not execute") })()');
    expect(normalizePluginPageRuntime(declaration)).toEqual(declaration);
    expect(
      normalizePluginPageRuntime(runtime('host => ({ receive: message => message })')),
    ).toBeDefined();
    expect(() => normalizePluginPageRuntime(runtime('host => {'))).toThrow(SyntaxError);
    expect(() => normalizePluginPageRuntime(runtime('const runtime = () => {}'))).toThrow(
      SyntaxError,
    );
  });

  it('preserves schema metadata while enforcing event declarations and limits', () => {
    const declaration = {
      ...runtime('host => ({})'),
      events: {
        changed: { command: 'save', schema: { customFormat: 'plugin-owned' }, concurrency: 2 },
      },
    };
    expect(normalizePluginPageRuntime(declaration)).toEqual(declaration);
    expect(() =>
      normalizePluginPageRuntime({
        ...declaration,
        events: { changed: { ...declaration.events.changed, concurrency: 9 } },
      }),
    ).toThrow('Invalid page event binding');
    expect(() =>
      normalizePluginPageRuntime({
        ...declaration,
        events: { changed: { ...declaration.events.changed, schema: [] } },
      }),
    ).toThrow('Invalid page event binding');
    expect(() => normalizePluginPageRuntime(runtime('x'.repeat(384 * 1024 + 1)))).toThrow(
      'Invalid plugin pageRuntime declaration',
    );
  });
});
