# @mearl/app-profiles

[简体中文](README.md) | [English](README.en.md)

Install an App Profile to emulate a client’s user agent, version, bridge objects, settings, scheme routes, business responses, and container behavior. This package validates and compiles Profiles and applies setting overrides.

## Develop an App Profile

Use [App Profile Creator](../../skills/mearl-profile-creator/SKILL.md) to build a profile from an existing definition, a sample of client behavior, or documentation. Register it under `contributions.appProfiles` in the [resource manifest](../../docs/browser-bundles.en.md), then open a fresh tab in a test browser to verify the initial page and bridge behavior.

## Compile a Profile

```ts
import { resolveAppProfileDefinition, type AppProfile } from '@mearl/app-profiles';

export function compileInstalledApp(definition: AppProfile) {
  return resolveAppProfileDefinition(definition, { os: 'android' });
}
```

Hosts can pass validated dynamic definitions to resolveAppProfile or resolveAppProfileDefinition. The compiler preserves bridge, settings, and pageRuntime descriptors without executing capability code. Definitions and options are copied and bound to a revision; plugin upgrades do not directly alter active documents.

resolveAppProfileUpdate, rebuildAppProfileConfig, and updateAppProfileSetting preserve the precedence of explicit options, device appearance, and method overrides. The host passes Preset defaults, and existing user selections take priority. After installing a Profile, you can apply its recommended settings as needed.

Profiles declare the App behavior to emulate in controlled pages. The resource manifest links page runtimes and host handlers. See the [runtime contracts](../../docs/capability-model.en.md).

Profiles listed in the same resource manifest can share a `settingsGroup` to appear together in the device shell's gesture-bar settings. Each environment remains selectable by its own Profile ID.

## Agent capability discovery

`mearl get_capabilities`, SDK `getCapabilities()`, and MCP `browser_get_capabilities` query the target browser through the existing browser/session routing. By default they return actions, device presets, and App summaries. Pass `{ "app": "package/app" }` to expand bridge methods, adjustable settings, and default versions. A partial or unsupported catalog does not establish that an App is absent; entries with available=false cannot be enabled. Methods are grouped by declaration: responses are fixed replies, noop methods succeed without an implementation, and behaviors simulate behavior. None establishes that a real business operation is available.

Each Profile may declare optional `usage` metadata. Browser bundles and Node/Skill plugins use the same format:

```json
{
  "usage": {
    "description": "WebView and bridge behavior simulation",
    "limitations": ["Real device authorization requires the corresponding host capability"],
    "skills": ["example-skill"],
    "documentation": [{ "title": "Usage guide", "url": "https://example.com/docs" }]
  }
}
```

usage is limited to 4 KiB; description to 512 characters; and limitations, skills, and documentation to 8 entries each. Documentation URLs must use HTTPS without credentials. Queries read installed metadata only: they do not refresh plugins, open documentation, install or load Skills, or expose bridge scripts, global variable values, or fixed response contents. Skill names are author-provided entry points and do not imply installation. Use set_app_profile/tab_open for general operations and consult companion instructions for specialized workflows.
