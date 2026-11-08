import { describe, expect, it } from 'vitest';
import { publishArgs } from '../publish.mjs';

const manifests = [{ version: '3.0.0-beta.1', repository: { url: 'git+https://github.com/mearlhq/mearl.git' } }];
const ci = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'mearlhq/mearl', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'codex/open-source-ready' };

describe('beta publishing', () => {
  it('keeps pnpm git checks and the beta tag for trusted publishing', () => {
    expect(publishArgs(manifests)).toEqual(['--access', 'public', '--tag', 'beta', '--registry=https://registry.npmjs.org', '--publish-branch=main']);
    expect(publishArgs(manifests, { env: ci }).at(-1)).toBe('--publish-branch=codex/open-source-ready');
  });
  it.each([{ GITHUB_REPOSITORY: 'someone/mearl' }, { GITHUB_REF_TYPE: 'tag' }, { GITHUB_REF_NAME: 'feature/unreviewed' }])('rejects another CI identity: %j', patch => {
    expect(() => publishArgs(manifests, { env: { ...ci, ...patch } })).toThrow('approved repository');
  });
  it('rejects stable, mismatched and missing versions', () => {
    for (const values of [[], [{ version: '3.0.0' }], [...manifests, { version: '3.0.0-beta.2' }]]) expect(() => publishArgs(values)).toThrow('matching beta versions');
  });
  it('rejects published packages without the matching trusted repository', () => {
    expect(() => publishArgs([{ version: '3.0.0-beta.1' }])).toThrow('trusted GitHub repository');
    expect(() => publishArgs([{ ...manifests[0], repository: { url: 'git+https://github.com/example/fork.git' } }])).toThrow('trusted GitHub repository');
  });
});

const stable = [{ ...manifests[0], version: '3.0.0' }];
it('uses latest only for explicitly selected stable versions', () => {
  expect(publishArgs(stable, { channel: 'stable' })).toContain('latest');
  expect(publishArgs(stable, { channel: 'stable' }).at(-1)).toBe('--publish-branch=main');
  expect(() => publishArgs(stable)).toThrow('matching beta versions');
  expect(() => publishArgs(manifests, { channel: 'stable' })).toThrow('matching stable versions');
  expect(() => publishArgs(stable, { channel: 'next' })).toThrow('Choose beta or stable');
});
it('permits stable CI only for a manual run on main', () => {
  const options = { channel: 'stable', env: { ...ci, GITHUB_REF_NAME: 'main', GITHUB_EVENT_NAME: 'workflow_dispatch' } };
  expect(publishArgs(stable, options)).toContain('latest');
  expect(() => publishArgs(stable, { ...options, env: { ...options.env, GITHUB_EVENT_NAME: 'push' } })).toThrow('explicit manual run');
  expect(() => publishArgs(stable, { ...options, env: { ...options.env, GITHUB_REF_NAME: 'codex/open-source-ready' } })).toThrow('explicit manual run');
});
