import { describe, expect, it } from 'vitest';
import { describeBrowserCapabilities } from '../browserCapabilities.js';
import { validateAppProfileDefinition, type AppProfileDefinition, type AppProfileCatalogEntry } from '../appProfileDefinition.js';
import { actionRequiresDomainCheck } from '../proxyPermissions.js';

const definition: AppProfileDefinition = {
  name: 'example/app', label: 'Example', appName: 'Example', defaultAppVersion: '1',
  uaTokens: [], globals: { marker: 'PRIVATE_GLOBAL' }, bridges: [{ global: 'ExampleBridge', style: 'callback' }],
  activeEvents: [], schemes: [], actions: { open: ['open'], close: [], title: [], systemInfo: [], protocol: [], noop: ['ping'], responses: { user: { value: 'PRIVATE_RESPONSE' } } },
  usage: { description: 'App WebView testing', limitations: ['Needs the matching host for real device operations.'], skills: ['example-skill'], documentation: [{ title: 'Guide', url: 'https://example.com/docs' }] },
};
const profile: AppProfileCatalogEntry = { id: definition.name, label: definition.label, source: 'plugin', plugin: 'example', revision: 'r', definition };
const actions = ['get_capabilities', 'set_app_profile', 'set_device_emulation'];

describe('installed browser capability discovery', () => {
  it('composes accepted projections without raw definitions or extra runtime fields', () => {
    const projected = describeBrowserCapabilities(actions, { profiles: [profile], errors: [] }, { app: definition.name }).apps;
    (projected.entries[0] as any).runtimeSource = 'PRIVATE_RUNTIME';
    const summary = describeBrowserCapabilities(actions, { apps: projected });
    expect(summary.apps.entries[0].details).toBeUndefined();
    expect(summary.limitations).not.toContain('This Provider does not expose an installed App catalog.');
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_RUNTIME');
    const detail = describeBrowserCapabilities(actions, { apps: projected }, { app: definition.name });
    expect(detail.apps.entries[0].details).toEqual(projected.entries[0].details);
    detail.apps.entries[0].features.push('changed');
    detail.apps.entries[0].details!.bridges.push('changed');
    expect(projected.entries[0].features).not.toContain('changed');
    expect(projected.entries[0].details!.bridges).not.toContain('changed');
    expect(describeBrowserCapabilities(['page_snapshot'], { apps: projected }).apps).toMatchObject({ status: 'unsupported', entries: [] });
  });

  it('preserves projected completeness and filters explicit App requests', () => {
    const projected = describeBrowserCapabilities(actions, { profiles: [profile], errors: [] }).apps;
    projected.entries.push({ ...projected.entries[0], id: 'other/app' });
    expect(describeBrowserCapabilities(actions, { apps: projected }, { app: definition.name }).apps.entries.map(entry => entry.id)).toEqual([definition.name]);
    expect(() => describeBrowserCapabilities(actions, { apps: projected }, { app: 'missing/app' })).toThrow('not installed');
    projected.status = 'partial'; projected.issues.push({ plugin: 'offline', error: 'Unavailable' });
    expect(describeBrowserCapabilities(actions, { apps: projected }, { app: 'missing/app' }).apps).toEqual({ status: 'partial', entries: [], issues: [{ plugin: 'offline', error: 'Unavailable' }] });
  });
  it('returns a compact summary and exposes details only on demand, without runtime data', () => {
    const catalog = { profiles: [profile], errors: [] };
    const summary = describeBrowserCapabilities(actions, catalog);
    expect(summary.apps.status).toBe('available');
    expect(summary.apps.entries[0]).toMatchObject({ id: definition.name, available: true, features: ['userAgent', 'jsBridge', 'open', 'noop', 'responses'], usage: definition.usage });
    expect(summary.apps.entries[0].details).toBeUndefined();
    const detail = describeBrowserCapabilities(actions, catalog, { app: definition.name });
    expect(detail.apps.entries[0].details).toMatchObject({ bridges: ['ExampleBridge'], methods: { open: ['open'], noop: ['ping'], responses: ['user'] } });
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE_GLOBAL|PRIVATE_RESPONSE/);
    detail.apps.entries[0].usage!.skills!.push('changed');
    expect(definition.usage!.skills).toEqual(['example-skill']);
  });
  it('distinguishes empty, incomplete and unreported catalogs and unavailable profiles', () => {
    expect(describeBrowserCapabilities(actions, { profiles: [], errors: [] }).apps).toMatchObject({ status: 'available', entries: [] });
    const partial = describeBrowserCapabilities(actions, { profiles: [{ ...profile, available: false }], errors: [], offline: true });
    expect(partial.apps).toMatchObject({ status: 'partial', entries: [{ available: false }] });
    expect(describeBrowserCapabilities(actions, { profiles: [], errors: [{ plugin: 'broken', error: 'Invalid definition' }] }).apps.status).toBe('partial');
    expect(describeBrowserCapabilities(actions, undefined).apps.status).toBe('unsupported');
    const provider = describeBrowserCapabilities(['page_snapshot'], undefined);
    expect(provider.devicePresets).toEqual([]);
    expect(provider.apps.entries).toEqual([]);
    expect(() => describeBrowserCapabilities(actions, { profiles: [], errors: [] }, { app: 'missing' })).toThrow('not installed');
    expect(() => describeBrowserCapabilities(actions, undefined, { app: 1 } as any)).toThrow('Invalid');
    expect(describeBrowserCapabilities(actions, { profiles: [], errors: [], offline: true }, { app: 'unknown' }).apps).toMatchObject({ status: 'partial', entries: [] });
    expect(actionRequiresDomainCheck('get_capabilities')).toBe(false);
  });
  it('validates bounded author guidance and safe documentation links', () => {
    expect(validateAppProfileDefinition(definition).usage).toEqual(definition.usage);
    for (const usage of [
      { description: 'x'.repeat(513) }, { skills: Array(9).fill('skill') },
      { limitations: [1] }, { unknown: true },
      { documentation: [{ title: 'Bad', url: 'javascript:alert(1)' }] },
      { documentation: [{ title: 'Bad', url: 'https://user:password@example.com' }] },
    ]) expect(() => validateAppProfileDefinition({ ...definition, usage })).toThrow('usage');
  });
  it('accepts runtime-owned behavior IDs and JSON options without interpreting them', () => {
    const runtimeOptions = { geolocation: { reverseGeocodeApi: 'example.location' }, nested: [true, null] };
    const input = { ...definition, runtimeOptions, actions: { ...definition.actions, behaviors: { locate: 'example:location.v2' } } };
    expect(validateAppProfileDefinition(input)).toEqual(input);
    for (const behavior of ['', 'x'.repeat(97), 'function(){}', 'location;alert(1)']) {
      expect(() => validateAppProfileDefinition({ ...input, actions: { ...input.actions, behaviors: { locate: behavior } } })).toThrow('actions.behaviors');
    }
    expect(() => validateAppProfileDefinition({ ...input, runtimeOptions: [] })).toThrow('runtimeOptions');
    expect(() => validateAppProfileDefinition({ ...definition, geolocation: runtimeOptions.geolocation })).toThrow('definition');
  });
});
