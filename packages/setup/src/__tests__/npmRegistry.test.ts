import { describe, expect, it } from 'vitest';
import { OFFICIAL_NPM_REGISTRY, packageRegistryEnvironment } from '../npmRegistry.js';

describe('package registry selection', () => {
  it('uses the public registry for core packages', () => {
    expect(packageRegistryEnvironment('@mearl/client', { custom: 'kept' })).toEqual({ custom: 'kept', npm_config_registry: OFFICIAL_NPM_REGISTRY, NPM_CONFIG_REGISTRY: OFFICIAL_NPM_REGISTRY, BUN_CONFIG_REGISTRY: OFFICIAL_NPM_REGISTRY, 'npm_config_@mearl:registry': OFFICIAL_NPM_REGISTRY });
  });
  it.each(['@example/provider', 'skills', '@mearl-other/client'])('retains caller scope configuration for %s', name => {
    const env = { npm_config_registry: 'https://registry.example.com/' };
    expect(packageRegistryEnvironment(name, env)).toBe(env);
  });
});
