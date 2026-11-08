# Node capability packages

[简体中文](node-capabilities.md) | [English](node-capabilities.en.md)

Native Host provides browser/CDP control, plugin execution, and Agent services. Node capability packages supply handlers through the shared resource manifest and Preset package graph; browser-local packages can run independently. Setup and the web installation bridge share the installation coordinator, component states, and partial-install recovery.

See the [installation host](preset-installation.en.md) for exact local records, Node activation/rollback, and setup commands. Browser synchronization and external components report their actual pending states until installed.

## Resources and selection

Packages declare a host, a self-contained `.cjs` entry, and a limited hook-to-exported-handler map through `contributions.nodeRuntimes`:

```json
{
  "appProfiles": [],
  "nodeRuntimes": {
    "native-host": {
      "entry": "runtime.cjs",
      "bindings": { "sample.value": "value" }
    }
  }
}
```

The entry exports a factory receiving host services and module JSON configuration and returning a function table:

```js
module.exports = (host, config) => ({
  value: () => ({ version: host.version, enabled: config.enabled === true }),
});
```

`prepareNodeBundleSnapshot` validates all module metadata and quotas before copying and hashing code. Selection limits: 64 modules, 256 hooks, 16 MiB per module, and 64 MiB total resources. Module digests, configuration, and hook mappings form the revision. Duplicate modules and multiple providers for one hook are rejected; the installer first resolves inherited overrides into a final selection.

The installation host prepares exact code in `objects/<sha256>.cjs` in the capability directory, then atomically replaces `active-node.json`. `MEARL_CAPABILITY_DIR` overrides the default `~/.mearl/capabilities`. Native Host loads selections on startup or `node_capabilities_reload`; factories execute only after all code passes size and digest checks. It rechecks the selection revision and switches the entire active function table on success. Failures retain the previous table. Removing a selection disables new calls; existing authorization operations and requests retain their handlers.

During updates on the same host, unchanged code digests and effective configuration reuse factory results and handler references. Changing other modules does not mark an unchanged Agent as updated. All selected target resources are still validated before reuse; failure rejects the new selection.

This is trusted native code with host-process privileges. SHA checks establish exact resources; the `vm.Script` CommonJS wrapper is not a security sandbox. The installer owns source authorization. Browser MAIN world execution has a separate contract and does not require Native Host.

## Native Host contributions

`@mearl/native-host/capabilities` exports host service types and a generic registry. Handlers cover App profiles, page code, request protocols, event parsing, and browser entry points. `@mearl/plugin-tracking` supplies default analytics parsing; installed capabilities can override `tracking.request`. Missing required hooks report an uninstalled capability.

Request protocol `prepareRequest(resolved, cookies, stream?)` receives `readonly { name: string; value: string }[]`. Hosts filter Cookies by full URL and first-party partition, then sort by descending path length. Protocol signatures use the first value for each required name; generated headers preserve same-name Cookies in the list. Browser pure-computation hooks use the same JSON list, never a `Map` at capability boundaries. Hosts write HTTP and signed-response Cookies back to the browser; business capabilities need not synchronize storage.

App catalogs register IDs declared in manifests. Profiles declare UA, versions, runtime code, and available methods. Complete profiles require exact runtime code. Updates and rollbacks pin accepted versions. Switching selects only installed, available profiles; clearing simulation requires no capability.

## Page code lifecycle

CDP stores validated page code by digest. Browser identities and target IDs retain current and pending-navigation versions across host restarts. References release when local Chrome exits, a target closes, an authoritative target list confirms closure, or simulation is explicitly cleared. Main-document navigation retires old versions; activation/rollback transactions protect old code separately. Temporarily unreachable remote browsers retain references until reconnection reconciles the authoritative target list.

The cache is limited to 64 MiB, 256 code objects, and 4096 target references; cross-process mutations use record locks. Unreferenced objects are evicted as needed and reclaimed during clear/reconciliation. Active references are never evicted for a new installation: quota failure preserves the environment and reports failure. Integrity errors never execute substitute code.

## Optional protocols and agents

CLI plugins provide custom request commands and send HTTP through `send_request`. App simulation uses the `request.protocol` host contract; the core provides no signing algorithm, default appKey, or gateway. Browser uses `request.protocol.resolve/prepare/streamError`, with each request using one accepted module. `request.inspect` optionally supplies a request name, namespace, proxy information, and environment annotations; ordinary HTTP capture remains without it. `request.import` can transform imported responses; without it, no protocol wrapper is added.

`set_app_profile.networkControl` uses `{id,value}` to select an installed network control, or `null` to clear it. Node `browser.control` and Browser `browserControls` provide the same declarations; routing and cross-origin handling still use the generic core engine. Private page-code options pass through `runtimeOptions` JSON, uninterpreted by the core.

`agent.provider.<id>` returns a local Agent Provider factory. Removed or updated runtimes reject new sessions; existing sessions retain their implementation until closing. Cloud protocols use `cloud.connector.<scheme>` and `cloud.server.<mode>` and fail when missing. Qoder implementation, ACP SDK, and credential handling belong to optional `@mearl/plugin-qoder`.
