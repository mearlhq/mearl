import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { workspaceManifests } from './bump-version.mjs';

const repository = 'git+https://github.com/mearlhq/mearl.git';

export function publishArgs(manifests, { channel = 'beta', env = {} } = {}) {
  if (!['beta', 'stable'].includes(channel)) throw new Error('Choose beta or stable publishing');
  const version = manifests[0]?.version;
  const pattern = channel === 'beta' ? /^\d+\.\d+\.\d+-beta\.\d+$/ : /^\d+\.\d+\.\d+$/;
  if (!pattern.test(version) || manifests.some(value => value.version !== version)) {
    throw new Error(`Publishing ${channel} requires matching ${channel} versions in every workspace package`);
  }
  if (manifests.some(value => !value.private && value.repository?.url !== repository)) {
    throw new Error('Published packages must declare the trusted GitHub repository');
  }
  let branch = 'main';
  if (env.GITHUB_ACTIONS === 'true') {
    if (env.GITHUB_REPOSITORY !== 'mearlhq/mearl' || env.GITHUB_REF_TYPE !== 'branch' || !['main', 'codex/open-source-ready'].includes(env.GITHUB_REF_NAME)) {
      throw new Error('Publishing requires an approved repository and release branch');
    }
    if (channel === 'stable' && (env.GITHUB_REF_NAME !== 'main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch')) {
      throw new Error('Stable CI publishing requires an explicit manual run from main');
    }
    branch = env.GITHUB_REF_NAME;
  }
  return ['-r', 'publish', '--access', 'public', '--tag', channel === 'beta' ? 'beta' : 'latest', '--registry=https://registry.npmjs.org', `--publish-branch=${branch}`];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { channel: { type: 'string', default: 'beta' }, check: { type: 'boolean', default: false } } });
  const root = new URL('../', import.meta.url);
  const manifests = await Promise.all((await workspaceManifests()).map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const args = publishArgs(manifests, { channel: values.channel, env: process.env });
  if (values.check) console.log(`Release validation passed: ${manifests[0].version} (${values.channel})`);
  else execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' });
}
