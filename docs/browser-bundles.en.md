# Browser-local capability bundles

[简体中文](browser-bundles.md) | [English](browser-bundles.en.md)

`@mearl/preset/bundles` provides resource preparation shared by browsers and Node, plus browser-only IndexedDB snapshot storage. It does not require native-host. It also stores controlled-page runtime resources and generates injection source; it does not yet provide a one-click preset installation UI, a web communication bridge, or App-specific schemas.

See [browser Preset activation](browser-presets.en.md) for transactional activation of complete package sets and App implementation selection.

## Preparation and activation

```ts
import {
  BrowserBundleStore, createBundleFetchLoader, prepareBundle,
} from '@mearl/preset/bundles';

const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0' });
const previous = await store.get('sample');
const bundle = await prepareBundle('https://example.com/sample/bundle.json', {
  expectedId: 'sample',
  mearlApiVersion: '1.0.0',
  version: '^1',
  load: createBundleFetchLoader(),
});

// The host validates contributions, namespaces, and permissions here; a resource digest does not establish source trust.
await validateHostContributions(bundle);
await store.install(bundle, previous?.revision ?? null);
```

`prepareBundle` reads the manifest and all resources, verifies the expected package ID, version/API ranges, sizes, and SHA-256 digests, and returns an independent snapshot. The installer pins the expected source and checks browser permissions. Downloads omit credentials and reject redirects by default; authenticated loading requires a host-controlled fetch implementation.

Manifest format:

```json
{
  "schemaVersion": 1,
  "id": "sample",
  "version": "1.0.0",
  "requires": { "mearlApi": "^1" },
  "resources": {
    "profiles/app.json": {
      "sha256": "<64-character lowercase hexadecimal digest>",
      "byteLength": 1234
    }
  },
  "contributions": { "appProfiles": ["profiles/app.json"] }
}
```

Generate digests and sizes from real resources; the placeholders cannot be installed. Paths must be ordinary relative paths within the package directory, excluding URLs, parent directories, percent encoding, queries, and fragments. Limits: 64 KiB per manifest, 1–64 resources, and 16 MiB total resource bytes.

## Persistence and updates

- `install` revalidates resources and replaces the snapshot in one IndexedDB transaction conditional on the current revision. A concurrent update or removal changing that revision produces `BUNDLE_CONFLICT`.
- The revision covers the source, manifest, and every resource digest. Changing the download source also changes the revision.
- `get` and `list` restore and revalidate locally without accessing an online catalog. `list` reports corrupt packages individually while keeping others available.
- Incomplete downloads, digest mismatches, host validation failures, and transaction failures do not delete the previous snapshot.
- Up to 64 packages share a 64 MiB unique-byte budget with code retained by active documents. Packages store manifests and references; `objects` stores one copy of each digest-addressed resource, with no duplicate charge for shared resources. Hosts copy and bind active profile definitions rather than replacing in-flight documents by querying the latest snapshot. See the [capability model](capability-model.en.md) for the storage format.
- `remove` also requires the expected revision. Hosts manage active document resource ownership and deactivation; storage does not infer which tabs use a package.

Only snapshots passing host contribution validation may be marked installed and available. Node plugin directory caches cannot be imported directly as local installations, which could reactivate uninstalled plugins offline.

## Page runtimes

A package can declare `contributions.pageRuntimes: { main: "runtime/main.cjs" }`. The file must appear in resources and be at most 2 MiB. Host contributions bind code through `{ id: "sample/main", sha256 }`, validating namespaces, file digests, and contribution schemas. `readBundleText` only decodes UTF-8 and does not execute code.

A runtime is a self-contained CommonJS file exporting `install(config)`. Hosts use `buildPageRuntimeRegistrationSource` to generate registration code for the controlled page's MAIN world and `buildPageRuntimeCallSource` to dispatch configuration. Installation should be repeatable. Static document_start and debugger registration can occur in either order: configuration waits if its digest is not registered, and bound configurations cannot fall back to another runtime. Module code executes only in controlled pages, never in the extension Service Worker.

`pageRuntimeSource(sha256)` reads and revalidates locally cached code. Before switching, hosts retain exact versions with `pinPageRuntimes({ owner: sha256 })`, restore previous references on failure, and release them with `{ owner: null }` when closing or clearing the environment. Package replacement, removal, and reference changes reclaim code with no package or owner references in the same transaction. After restarting, hosts call `synchronizePageRuntimePins` from authoritative session state to remove temporary references left by interrupted operations. References to missing code may remain so affected environments report corruption individually.

The same cache stores browser background modules; `browserRuntimeBytes(sha256)` validates and returns their bytes. An extension App binding pins the digests, configuration, and handlers for page code, user information, and PROTOCOL host modules. Provider updates or removal leave accepted implementations active. Changing settings or versions within the same definition preserves the binding; explicitly refreshing a definition selects modules again. Rule restoration rebuilds references and clearing a binding releases them. Every request still checks current domain and Cookie permissions; missing or corrupt bound code never falls back to another implementation.

Code digests establish integrity, not trust or authorization. Hosts own source policy, user authorization, execution location, and applicable extension distribution requirements. This library does not expose extension APIs to pages or execute privileged host code.

UI background operations can be declared through [browser background capabilities](browser-services.en.md), using restricted host interfaces for requests and Cookies.

## Validation

Automated tests cover download integrity, path traversal, version/API requirements, cancellation, storage reopening, corrupt updates, concurrent conflicts, and isolation of corrupt packages. `pnpm check:preset-browser` runs preparation and validation without Node globals.

Real-browser fixture:

```bash
node scripts/browser-bundle-fixture.mjs
```

The fixture returns a local URL. In an isolated browser, click Install sample bundle, Reload and restore, then Attempt corrupt update. The version should remain 1.0.0. Resource endpoints return 503 after initial installation; reloading should still show restored, and the corrupt update should show rejected-corrupt-update. `/state.json` should show only two resource downloads and packagesAvailable=false. Stop with Ctrl+C or enter close in the terminal.

This flow passed in isolated Chrome on 2026-10-22. The driver used Mearl, but the fixture page and tested package did not connect to the extension or native-host. This verifies browser persistence and preparation, rather than complete extension entry bridges, child WebViews, or UI equivalence.
