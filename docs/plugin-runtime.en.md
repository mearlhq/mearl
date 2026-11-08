# Plugin runtime contract

[简体中文](plugin-runtime.md) | [English](plugin-runtime.en.md)

The plugin runtime provides command execution, task recovery, page instances, and persistent state. CLI, SDK, MCP, and toolbox use the same host contract.

## Checkpoints and explicit recovery

Command entries can declare `taskRecovery` and register matching `app.recoveryCommand()` handlers. These run only in host-created recovery attempts, never through public commands, toolbox allowlists, or nested invocation.

```javascript
export const taskRecovery = { version: 1, commands: {
  work: { checkpointVersion: 1, schema: { type: 'object', properties: {
    operationId: { type: 'string' },
  }, required: ['operationId'], additionalProperties: false } },
} };
export default app => {
  app.command('work', async (input, context) => {
    const operationId = await createIdempotentOperation(input);
    await context.checkpoint({ operationId }, 0);
    return waitForOperation(operationId);
  });
  app.recoveryCommand('work', async (input, context) => {
    const { operationId } = context.recovery.checkpoint.data;
    return reconcileOrWaitForOperation(operationId);
  });
};
```

`context.checkpoint(data, expectedSequence)` is available only in active, managed public commands with service routing and no page-instance binding. Child tasks may checkpoint, but explicit recovery accepts eligible root tasks only. Payloads are limited to 64 KiB and plugin-validated against declared schemas; the host assigns increasing sequences. Data, versions, host-computed canonical schemaHash, task snapshots, and checkpoint events commit in one atomic task record. Stale concurrent writes conflict explicitly. Checkpoints do not prove completion of external operations or share commits with plugin state transactions. Recovery handlers must close the failure window between external submission and checkpointing by querying operation state or using stable idempotency keys.

SDK methods are `PluginTaskClient.checkpoint(taskId)` / `resume(taskId, { environment?, revision? })`. resume accepts only failed, cancelled, or interrupted root commands. It creates a new taskId and execution generation with `resumedFrom`, leaving the original terminal. A source task has at most one direct successor; duplicate requests return that attempt, while different configuration conflicts. To recover a failed new attempt, resume its new taskId.

Recovery defaults to `revision: 'original'`, retaining the original installation, source snapshot, input, cwd, routing, and execution time limit. Before acceptance, ownership and all source hashes are revalidated. Missing or corrupt snapshots are rejected without falling back to current code. The original environment is not persisted. By default the SDK explicitly submits the calling process's current environment, or callers can supply environment; the service environment is not substituted. `context.recovery` includes fromTaskId, fromRevision, the original sourceCheckpoint format reference, and accepted checkpoint. The new attempt inherits data but starts its checkpoint sequence at 0; resumedFrom preserves the original revision/version/sequence. Hidden recovery handlers receive original input without requiring compliance with the current CLI's required arguments and must handle historical input themselves.

Explicit `resume(taskId, { revision: 'current' })` pins the registered source snapshot when the first request arrives. Matching format versions and canonical schemas are accepted directly. Changing a schema without increasing checkpointVersion is rejected. Cross-version recovery supports only a target-declared single-step migration:

```javascript
export const taskRecovery = { version: 1, commands: {
  work: { checkpointVersion: 2, schema: currentSchema,
    migrateFrom: [{ version: 1, schema: historicalSchema }] },
} };
export default app => {
  app.command('work', runWork);
  app.checkpointMigration('work', ({ checkpoint, fromRevision, toRevision }) => {
    return { operationId: checkpoint.data.id };
  });
  app.recoveryCommand('work', recoverWork);
};
```

migrateFrom supports up to 16 distinct earlier versions, all below the target. Historical schemas must match both the host hash recorded at checkpoint time and retained source declarations. Dynamic declaration drift, including dependency-environment changes, rejects recovery even with unchanged source. Migration/recovery processes recheck target declaration signatures before hidden handlers; ordinary checkpoint writes also check executing declarations. Each Python run validates full loading metadata before its ready ACK. Migration returns target checkpoint data, validated by the plugin against the target schema; the host checks JSON and the 64 KiB limit before atomically saving data and provenance into the unique successor. Original tasks and checkpoints remain unchanged. Missing migrations, format mismatches, conversion failures, or unconfirmed cleanup reject new tasks.

Concurrent recovery of one source task coalesces by revision choice and environment fingerprint; different intents conflict. Retries of committed successors verify request fingerprints without rerunning conversion. Migration runs in an independent managed process with a 10-second limit, sharing an eight-process budget with declaration parsing and no wait queue. Service shutdown cancels it and waits for cleanup. Acceptance requires confirmed termination of both conversion and original execution trees, plus revalidation of installation and both source snapshots. Migration has no host APIs, models, state, pages, or nested plugin calls. JS/Python remains trusted native code with direct file/network access, not an OS sandbox. Migration must be repeatable pure JSON conversion: crashes before commit may rerun it, with no exactly-once guarantee.

Recovery currently supports root commands with public entries and stable service-owned routes only. Toolbox/Native Host caller routes, page bindings, models, and child tasks explicitly reject recovery because their lifecycle cannot be inferred from an old task. Before acceptance, the host recursively checks supervising processes, OS creation identities, and POSIX groups for the task and all descendants. Running execution or unconfirmed cleanup rejects recovery; uncertain ownership records do not expire away. Windows also rejects recovery after service crashes without full process-tree termination proof. Recovery handlers can explicitly request models as new executions.

## Page runtimes and events

Plugins can write generated HTML previews to `~/.mearl/plugin-previews/<plugin>/`, declare a local file scope in `pageRuntime.matches`, and attach to the main frame. Activation rules require exact `file://` URLs. Queries and fragments configure the preview. The host checks that the file is in the plugin's preview directory and rejects symlinks. The extension also requires user scripts and local file access.

Page instances bind plugin revision, browser source, tab, frame, document, and instance ID. Business frame selectors resolve at attach time, then the target is fixed. Switching business WebViews invalidates old instances and creates new ones. Extension uses native documentId; pure CDP uses the default execution context's uniqueId for document identity, executes plugin code in isolated worlds, and passes events through validated CDP bindings, including cross-origin iframes. Chromium without uniqueId uses connection-local document identities; reconnecting invalidates old instances for activation rules to rebuild. External Providers must declare `page_runtime` or fail explicitly.

`PluginPageRuntimeHost` in `browser-core` shares instance lifecycle, event acknowledgment/retransmission, activation rules, leases, and chunked transport. Extension and CDP implement only document resolution, script execution, ports, and storage adapters. CDP sessions are isolated by browser endpoint identity; host restarts preserve session identity, while browser restarts clear session rules but retain persistent rules. Only endpoint digests are stored. CDP inherits connection permissions, while the common host still checks declared plugin URL scopes.

The CDP session layer persists target-to-virtual-tabId mappings by browser endpoint identity and restores them before page discovery and plugin reconciliation. Page storage persists independently by storage key; lease updates write only lease records. Document resolution also returns its target, and execution waits only for that target.

After native-host cleanup or transient disconnects, document instances retain ownership for a 30-second lease from the last successful validation. Unverifiable document operations return `PLUGIN_PAGE_UNAVAILABLE`, without performing page actions or treating failed reconciliation as absent instances. Reconnection must verify the original browser, document, and instance. Accepted events whose tasks have not started can stay queued; dispatched operations are not replayed. Explicit navigation, unloading, or invalidation cleans up immediately. Extended disconnects expire leases and old instances; enabled activation rules can create replacements after recovery.

CDP page-session files are reclaimed when one connection identifier changes browser identity, a controlled browser explicitly closes, or process exit is confirmed. Persistent activation rules remain.
Session files without verifiable browser ownership remain until full uninstall. `cdp-targets` tab-ID counters persist across browser lifecycles to prevent stale requests from targeting new tabs.
Controlled-browser logs rotate before launch at 5 MiB with one backup. Logs without browser records remain for seven days and are cleaned during host startup, browser queries, or launch.

The host provides `attach/get/list/send/detach` independently of toolbox declarations. Closing a tool page unsubscribes UI only. Document refresh rebuilds according to policy; SPA navigation notifies instances; plugin deactivation removes events and resources. Instance validity is checked on dequeue, before key host calls, and before writes.

Runtime event declarations specify event, payload schema, command, and serial, pending-coalescing, or bounded-concurrency policy. Hosts validate real sources and bound payloads and queues. Events are numbered by instance and connection generation. Receipt acknowledgment is separate from business completion, and retransmission deduplication from business retry. Cache gaps require resynchronization; document invalidation discards old events. Exactly-once execution across failures is not guaranteed.

Page instances are shared by plugin installation and real target document. Concurrent attach from CLI, toolbox, and automatic activation waits for one initialization. Toolbox can access only its own plugin. `pageRuntime` is independent of toolbox declarations; JS entries export function source and URL scope, and `app.runtimeCommand()` registers background initialization and event handlers. Public/toolbox commands cannot call these directly. Registration code is read in managed, terminable child processes.

Python entries may export the same `pageRuntime` dictionary, with `code` containing a browser JavaScript function string. `app.runtimeCommand()` supports direct registration and decorators. Python `app.page()` and instance-bound `context.page.send/get` synchronously bridge to the same page service. Runtime-only markers participate in descriptor validation and actual Python handler selection; public/toolbox commands cannot execute them directly. Ordinary `app.command` handlers also used for page events remain public. Every Python run checks the full descriptor, including page declarations and command visibility, before its ready ACK.

```javascript
export const pageRuntime = {
  version: 1,
  matches: ['https://example.com/*'],
  initialize: 'initialize',
  code: `host => ({
    receive(message) { return { title: document.title }; },
    dispose() { /* release listeners and DOM owned by this instance */ },
  })`,
  events: { changed: { command: 'save', policy: 'latest',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } },
};
export default app => {
  app.runtimeCommand('initialize', (input, context) => context.page.send({ type: 'initialize' }));
  app.runtimeCommand('save', ({ event }, context) => save(event.payload));
  app.command('open', input => app.page('attach', { tabId: input.tabId, frame: 'business' }));
};
```

Page-function `host.emit(name, payload)` returns receipt acknowledgment; query instance events for processing results. `context.page.send/get` always binds the current instance. Ordinary and compound page actions from runtime tasks are rejected. Each dequeue, host call, and result commit rechecks the document. Runtime transport preserves control-session ownership, pause, and release checks, processing messages and callbacks in parallel. Instances and event policies own ordering; waiting for business messages does not block same-document validation or cancellation. Page `receive(message, { signal, requestId })` supplies cooperative per-message cancellation. Task cancellation propagates to that document request; plugins should check signal after asynchronous waits. Cancellation does not forcibly stop page JS, so external operations still need reconciliation. Background renewal defaults to concurrent checks every 10 seconds, with eight-second per-instance validation and 30-second browser leases. Renewal updates memory only; a separate timer saves lightweight leases every five seconds. Full code and pending events persist only on relevant state changes. Invalidation cancels queued/running tasks and releases page resources.

Event payloads are limited to 32 KiB; page unacknowledged queues to 64 entries. Background pending queues default to 32 per event (maximum 64); active events to 128 per instance; bounded concurrency to 8. History is limited to 256 entries and 384 KiB, with explicit cursor-gap errors. Native Messaging chunks requests and results at 192 KiB with SHA-256 checks. A page business message/result is limited to 24 MiB. Browser and toolbox reply resources each have a 32 MiB aggregate budget and expire after 30 seconds.

The SDK uses `PluginPageClient`. Toolbox uses `host.page.*` or `window.mearl.subscribe('page', { instanceId, cursor? }, listener)` for background events. `events` accepts `cursor` and `waitMs` (0–25000) to wait for changes. Toolbox subscriptions read a snapshot first, then long-poll; unsubscribing only stops observation. Internal `page_runtime` is a document adapter protocol; business plugins use `app.page()`. The execution service handles save events without Popup forwarding.

Explicitly configure activation through `app.page('activation', { enabled: true, matches, persistence: 'session' | 'persistent', frame, input })`. Effective scope is the intersection of user rules and declarations. Automatic instances recheck it at injection, SPA navigation, and regular validation, invalidating when outside scope. Manual attachment follows declarations. Disabling rules cleans instances; rule generations block in-flight stale attaches. After extension worker restart, handshake with the execution service verifies hostId, service epoch, installation, revision, browserSessionId, documentId, and instanceId. The same owner resumes unacknowledged events from the service's received position, which only advances. Connection epochs do not change business event sequences. Temporary bridge outages retain queues for reconciliation until lease expiry.

To change matching scope independently, pass `enabled: true, matchPatch: { add?: string[], remove?: string[] }`, mutually exclusive with `matches`. Hosts atomically add/remove scopes to avoid concurrent overwrites. Removing the final scope disables automatic activation while retaining manually attached instances. `persistence: 'persistent'` survives browser restarts. Initialization handlers can read current plugin preferences instead of copying volatile settings into rule input.

Service epoch changes, missing instances, or regressed receipt positions invalidate old instances and queues without replaying events into a new service. Existing activation rules can create new instances; manual instances require attach again. Rules bind installation IDs, so uninstalling or changing source does not transfer authorization to same-name replacements. Injection serializes handoff in an isolated script world, awaiting old handler dispose before creating a new instance so old overlays cannot remove new DOM.

## State and activation

Plugins export `stateStorage = { version: 1, collections: { ... } }`. Collections declare `scope` (installation/host/browser-session/instance), `storage` (persistent/cache/memory), `schemaVersion`, JSON Schema, and optional `maxEntries/maxBytes/ttlMs`. Browser-session and instance scopes accept only cache/memory. memory supports only those scopes, resides solely in the execution host, allocates on demand, and shares a host-wide 128 MiB / 512-namespace limit. Host restart clears it; instance end releases its memory. Browser-session state survives document refresh but is isolated across browser sessions. Real active pages determine all page scopes; business fields cannot forge them. Instance end clears dedicated caches. Other caches default to a one-day TTL, maximum seven days; reads, maintenance, and quota checks reclaim expiry. Persistent settings, caches, task records, and binary assets are managed separately.

If a namespace already has state, switching between memory and disk requires a new collection name or scope. Cross-medium migration is unsupported.

`get/list/transact` serialize in the user-level task service. Values, CAS versions, schema versions, TTLs, and the latest 64 idempotency receipts persist in one atomic record. Each put/delete requires the opaque `expectedVersion` obtained by reading. Collection versions increase monotonically and are never reused after deletion or expiry. Multi-key transactions allow 128 operations and 512 KiB; single values 256 KiB. Collections default to 1024 entries / 8 MiB, with disk state limited to 64 MiB per plugin. memory uses the host-wide limit above. list is bounded and paginated; callers use `expectedRevision` to detect changes between pages.

Schema or storage-type changes require increasing `schemaVersion`. Migration transactions explicitly supply `migrateFromVersion` and `expectedRevision`. The plugin validates all retained values against the new schema before submission; the host checks JSON, size, versions, and transaction constraints and commits atomically. Old revisions cannot write into new schemas. Synchronous handlers also verify declaration signatures captured at load time to prevent writes during code updates. New installations never inherit old installation namespaces.

Commands use `app.state(collection, operation, input)` or `context.state(...)`, automatically bound to the current page instance. SDK `PluginStateClient` and toolbox `host.state.*` share the service. Assets and settings may use browser-session memory with bounded chunked reads/writes. Explicitly exported user images are not cache.

Plugins declare available URL scopes and activation entries. User rules control enablement, matching, and cross-restart persistence. Activation maintains page instances; explicit invocation or events trigger business commands. Extension, browser, and execution-service restarts reconcile instances and tasks through handshakes to prevent duplicate recovery.
