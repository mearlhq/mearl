# Preset resource preparation

[简体中文](preset-preparation.md) | [English](preset-preparation.en.md)

`preparePreset` from `@mearl/preset/bundles` shares resource preparation between setup and browser installation views. It resolves inheritance once and downloads resources for the final enabled `packages`. Packages targeting both browser and Node download only once. Inherited manifests, package manifests, and resources share a 64 MiB download budget, with at most 64 packages selected.

```ts
import { preparePreset, verifyPreset, createBundleFetchLoader } from '@mearl/preset/bundles';
import { prepareNodeBundleSnapshot } from '@mearl/preset';

const prepared = await preparePreset('https://example.com/presets/team.json', {
  mearlApiVersion: '1.0.0',
  load: createBundleFetchLoader(),
});
const node = await prepareNodeBundleSnapshot(
  prepared.bundles.filter(bundle => prepared.preset.packages[bundle.manifest.id].targets?.includes('node')),
  'native-host',
  '1.0.0',
);
const restored = await verifyPreset(prepared.snapshot, '1.0.0');
```

The loader owns source trust, credentials, actual network permissions, and cancellation. This code does not install, execute factories, write local files, or request browser permissions. `node` contains exact module/configuration/hook selections and validated code for the Node installation host; Node handler conflicts are rejected at this step.

`prepared.snapshot` records a complete `schemaVersion: 1` package graph, exact inherited manifests, package revisions, and `packageTargets`. `verifyPreset` re-resolves and verifies the graph offline; installation storage must still verify resource bytes. `prepared.browser` projects the same resources into a `PreparedBrowserPreset` for IndexedDB atomic activation; its revision covers exact package selection and targets. Full and browser snapshots are not interchangeable, preventing a partial result omitting Node packages from being treated as a complete installation record.

Contributions determine supported execution locations. Preset `targets` selects a subset or infers targets when omitted, saving them in `packageTargets`. Once all targets are discovered, per-target dependencies are checked before downloading selected resources. Independent browser installation still uses `prepareBrowserPreset`, may read manifests to discover targets, excludes Node-only resources, and does not require Node online. Full preparation rejects version, digest, or download failures as a whole without returning partial success.

`skills`, `providers`, defaults, permission requirements, and declaration sources remain in the resolved result. This step does not run Skills/npm installation or report those components ready. The installation host must handle complete receipts, user overrides, synchronization on both sides, and UI. Resource preparation alone must not display overall installation success.
