# @mearl/preset

[简体中文](README.md) | [English](README.en.md)

Use a Preset to distribute a configured set of Mearl capabilities, Skills, and Providers. This package resolves the manifest and prepares the resources that browser and Node hosts use.

See the [capability model](../../docs/capability-model.en.md) for 3.x declarations, configuration, catalogs, and object storage. Contributions infer supported targets; optional Preset `targets` selects a subset. Operations and logins belong to packages; configuration overrides belong to Presets and users.

See [browser bundles](../../docs/browser-bundles.en.md) for preparation and local storage, and [browser Presets](../../docs/browser-presets.en.md) for atomic activation and App implementation mappings. Both are exported through `@mearl/preset/bundles`.

Browser and Node share one inheritance resolution and resource download; see [complete resource preparation](../../docs/preset-preparation.en.md). `preparePreset` returns the full exact graph and a compatible browser projection. Node module selection reuses the same bytes. Preparation executes no code and installs no external environment.

The main entry shares preset validation and inheritance resolution across browsers and Node, without filesystem, network, credential, or browser permission side effects. Callers supply manifest loading. Optional `@mearl/preset/bundles` provides resource validation, bounded downloads, and explicitly invoked browser-local storage; see [browser bundles](../../docs/browser-bundles.en.md).

```ts
import { resolvePreset, mergePresetDefaults } from '@mearl/preset';

const preset = await resolvePreset('https://example.com/presets/team.json', {
  mearlApiVersion: '1.0.0',
  async load(source) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Preset load failed: ${response.status}`);
    return response.json();
  },
});

const effectiveSettings = mergePresetDefaults(preset.defaults, userSettings);
```

Loaders check source policy, response size, redirects, authentication, and cancellation; the example only demonstrates the contract. Browser loaders should restrict URLs according to product source policies. The resolver does not automatically trust HTTP(S)/file URLs.

See [Node capabilities](../../docs/node-capabilities.en.md) for module snapshots and host loading contracts.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "team",
  "version": "1.0.0",
  "extends": { "source": "../base/preset.json", "version": "^1" },
  "requires": { "mearlApi": "^1" },
  "packages": {
    "capture": { "source": "./capture/package.json", "targets": ["browser"] },
    "unused": { "enabled": false }
  },
  "skills": {},
  "providers": {},
  "defaults": { "simulation": { "app": "sample" } },
  "permissions": { "origins": ["https://*.example.com/*"] }
}
```

- Single inheritance, at most 32 levels; cycles and unmet parent version/API requirements are rejected. `version` is exact semver; component `version` is a version requirement, with concrete installation versions resolved by installers.
- packages, skills, and providers merge by ID; child fields override the same ID, while arrays replace entirely. Enabled entries must ultimately have a source; `enabled:false` retains a disabled declaration.
- Component `dependsOn` references IDs of the same component type. The final inherited graph checks missing, disabled, and cyclic dependencies. This does not establish runtime compatibility or completed installation.
- source resolves relative to the declaring manifest. A child changing only the version does not alter an inherited source's base URL.
- Skills may declare up to 16 previous sources in `migrateFrom`, resolved relative to the declaring manifest. Children replace the whole list; an empty array clears it. Installers migrate only with a matching source receipt, valid Skill identity, and setup ownership of all associated plugins. Manual registrations, shared manual aliases, and other sources remain and report conflicts. Source matching still checks refs strictly.
- defaults recursively merges objects; arrays, scalars, and null replace values. User overrides are saved separately and applied to the resolved result.
- Permissions are aggregated and deduplicated as requirements only; browser installers obtain actual authorization separately.
- appProfiles maps App IDs to implementation identifiers. Later capability catalogs verify profile existence and package executability; the resolver does not claim simulation validation.
- Results retain the exact parent-to-child version chain and each component's latest declaration source. Loading failures do not produce partial success.
- Unknown fields, non-JSON configuration, and prototype-pollution keys are rejected. Total manifests are limited to 256 Ki UTF-16 code units; defaults nesting to 32 levels.

This package owns generic manifest parsing, validation, and resource graphs, without installation or UI. Browser hosts and setup own full installation, preset lock persistence, permissions, registration, and activation; see the [installation host](../../docs/preset-installation.en.md). Bundle-local storage transactionally replaces validated snapshots.

The Skill manager's optional `readSources(scope, cwd)` returns manager-verified source receipts matching setup's `TrackedSkillSource`. CLI and Native installation status share this reader. Managers persist, validate, and invalidate their supplementary records; public hosts still verify sources, refs, manifest identity, and managed ownership. Without it, the standard Skills lockfile is read.

## Tool catalogs

Presets can register additional installable tool catalogs through `defaults.extension.toolCatalogs`:

```json
{
  "defaults": {
    "extension": {
      "toolCatalogs": {
        "team": {
          "url": "https://tools.example.com/toolbox.json",
          "label": "Team"
        }
      }
    }
  }
}
```

Use absolute HTTPS URLs (loopback HTTP is allowed for local development), with at most 16 catalogs. Use stable IDs; child presets can override only `url` or `label`, or disable a parent catalog with `enabled: false`. The official catalog always remains first; `official` is reserved. Declare cross-origin domains in `permissions.origins` and obtain access through the existing authorization flow.

Catalog JSON shares the official structure, limited to 256 entries and 256 KiB:

```json
{
  "tools": [{
    "id": "plugin:team-tool",
    "plugin": "team-tool",
    "repository": "example/skills",
    "skill": "team-tool",
    "title": "Team tool",
    "description": "A tool for the team",
    "icon": "wrench"
  }]
}
```

`repository` also supports HTTPS/SSH Git sources and pinned refs such as `git@code.example.com:team/skills.git#release/v3`, passed unchanged to the preset-selected Skills manager. Manifests reject shell arguments, credentials, and local paths, and execute no embedded code. Listing tools does not install them.

Sources load concurrently and cache independently. Retry refreshes the current catalog; failure retains its cache without blocking other sources. Identical plugin IDs and sources deduplicate. Conflicting repositories or Skills for one ID retain the higher-priority catalog and report a conflict. Lower-priority install buttons wait for earlier catalogs to finish checking, so load order cannot change installation targets. Replaced or disabled catalogs and late responses do not remain in the current list.
