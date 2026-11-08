const repository = 'git+https://github.com/mearlhq/mearl.git';

export function publishArgs(manifests, { channel = 'beta', env = {} } = {}) {
  if (!['beta', 'stable', 'patch'].includes(channel)) throw new Error('Choose beta, stable or patch publishing');
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
    if (channel !== 'beta' && (env.GITHUB_REF_NAME !== 'main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch')) {
      throw new Error('Stable CI publishing requires an explicit manual run from main');
    }
    branch = env.GITHUB_REF_NAME;
  }
  return ['--access', 'public', '--tag', channel === 'beta' ? 'beta' : 'latest', '--registry=https://registry.npmjs.org', `--publish-branch=${branch}`];
}
