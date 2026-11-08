export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/';

/** Core packages use their public registry; other scopes retain the caller's configuration. */
export function packageRegistryEnvironment(packageName: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (packageName.split('/')[0] !== '@mearl') return env;
  return { ...env, npm_config_registry: OFFICIAL_NPM_REGISTRY, NPM_CONFIG_REGISTRY: OFFICIAL_NPM_REGISTRY,
    BUN_CONFIG_REGISTRY: OFFICIAL_NPM_REGISTRY, 'npm_config_@mearl:registry': OFFICIAL_NPM_REGISTRY };
}
