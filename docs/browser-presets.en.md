# Browser Preset activation

[简体中文](browser-presets.md) | [English](browser-presets.en.md)

`@mearl/preset/bundles` prepares and atomically activates the browser part of a preset. Package contributions determine supported execution locations; `targets: ["browser"]` selects a subset, or omission infers targets automatically. The exact graph's `packageTargets` stores the result. Packages supporting both locations require separate installation on each side. See the [capability model](capability-model.en.md).

```ts
const previous = await store.list();
const prepared = await prepareBrowserPreset(source, {
  load: createBundleFetchLoader(), mearlApiVersion: '1.0.0',
});
// The host validates every contribution schema, namespace, and mapping target before activation.
await validateHostContributions(prepared);
await store.activatePreset(prepared.snapshot, prepared.bundles.map(bundle => ({
  bundle, expectedRevision: previous.revisions[bundle.manifest.id] ?? null,
})), previous.activeRevision);
```

`prepareBrowserPreset` resolves inheritance, saves the exact manifest graph, prepares browser packages, and checks that App implementations belong to enabled browser packages. Browser packages cannot depend on Node-only packages. Hosts must still validate that mappings point to real contributions rather than accepting profile IDs based only on string format.

Downloads share a 64 MiB budget across presets, package manifests, and resources; reaching it stops further requests. Constrained hosts can lower it with `maxDownloadBytes`. Persistent resources also have a 64 MiB limit. Activation checks total resource size before copying and validating all packages. The final transaction also checks existing independent packages and page runtime code retained by active environments.

Package resources and the preset pointer switch in one IndexedDB transaction, checking both the previous preset revision and each package revision. Download, contribution validation, quota, or concurrency failures preserve previous state. Upgrading a version 1 database preserves independently installed packages.

`activePreset()` resolves only the saved parent/child manifest graph to recover exact inheritance, defaults, and all component declarations without network access. `profileBinding(appId)` reads the selected implementation and exact local resources, rejecting changed or corrupt providers. Hosts bind the implementation to the original App ID, preserving menu placement, user setting keys, and call identity. Page configurations pin their own definitions; installation does not rewrite open pages.

`list()` returns the valid binding graph, per-package errors, current preset revision, and package revisions. A corrupt package retains binding information from its valid manifest so hosts disable only affected Apps. A corrupt manifest graph reports `activationError` rather than silently appearing as no preset. Single-package install/remove cannot bypass updates for packages managed by the active preset.

Switching presets retains independently installed and unselected packages. Package and host owner references govern page runtime code reclamation; see [browser bundles](browser-bundles.en.md#page-runtimes). Hosts manage Node components, Skills, Providers, and default configuration. The installation coordinator aggregates overall readiness.

The `node scripts/browser-bundle-fixture.mjs` fixture supports clicking **Install sample preset**, then **Reload and restore** at a fresh local URL. It should keep showing `selectedProvider: "sample/app"` without additional resource downloads after the resource endpoints close. This verifies local transactions and mappings, rather than complete App simulation.

This preset flow passed in isolated Chrome on 2026-10-22, including readable mappings after a rejected corrupt update. Resource endpoints were closed and resource downloads remained at two. The driver used Mearl; the fixture page and tested library did not connect to the extension or Native Host.
