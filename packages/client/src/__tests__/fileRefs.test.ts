import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFileRefs } from '../fileRefs';

let dir: string;
let jsonFile: string;
let textFile: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-fileRefs-'));
  jsonFile = path.join(dir, 'payload.json');
  textFile = path.join(dir, 'script.txt');
  fs.writeFileSync(jsonFile, JSON.stringify({ hello: 'world', n: 1 }));
  fs.writeFileSync(textFile, 'console.log(1)');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveFileRefs', () => {
  it('returns non-object input unchanged', () => {
    expect(resolveFileRefs(null as never)).toBeNull();
    expect(resolveFileRefs([1, 2] as never)).toEqual([1, 2]);
  });

  it('leaves plain values (no @ prefix) untouched', () => {
    expect(resolveFileRefs({ a: 'plain', b: 1, c: true })).toEqual({ a: 'plain', b: 1, c: true });
  });

  it('parses a referenced JSON file into an object', () => {
    expect(resolveFileRefs({ body: `@${jsonFile}` })).toEqual({
      body: { hello: 'world', n: 1 },
    });
  });

  it('injects a non-JSON file as raw text', () => {
    expect(resolveFileRefs({ script: `@${textFile}` })).toEqual({
      script: 'console.log(1)',
    });
  });

  it('keeps the original string when the file cannot be read', () => {
    const missing = `@${path.join(dir, 'does-not-exist.json')}`;
    expect(resolveFileRefs({ body: missing })).toEqual({ body: missing });
  });

  it('does not treat a bare "@" as a file reference', () => {
    expect(resolveFileRefs({ handle: '@' })).toEqual({ handle: '@' });
  });

  it('only resolves top-level fields, not nested ones', () => {
    const nested = { outer: { inner: `@${jsonFile}` } };
    expect(resolveFileRefs(nested)).toEqual(nested);
  });

  it('does not mutate the input object', () => {
    const input = { body: `@${jsonFile}` };
    resolveFileRefs(input);
    expect(input.body).toBe(`@${jsonFile}`);
  });
});
