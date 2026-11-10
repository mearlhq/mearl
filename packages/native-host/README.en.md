# @mearl/native-host

[简体中文](README.md) | [English](README.en.md)

Mearl's Native Messaging Host bridges the Chrome extension and local socket services.

The extension starts this process through `chrome.runtime.connectNative()`. Hosts interact with browsers through Extension or CDP and serve callers such as `@mearl/client` over local IPC: Unix sockets on macOS/Linux and named pipes on Windows. Cloud Connector uses the same host connection.

## Dynamic capabilities

Hosts provide browser control, device simulation, plugin execution, and default analytics parsing. Node capability packages supply declared hook handlers; see [Node capabilities](../../docs/node-capabilities.en.md) for resources, activation, and rollback. Setup and web installation share the [installation host](../../docs/preset-installation.en.md) coordinator.

## Installation and registration

Register Native Messaging Host manifests so browsers can launch this process:

```bash
# Register both Skills and MCP integration modes (default)
mearl-native-host --init

# Register one mode only
mearl-native-host --init --mode skills
mearl-native-host --init --mode mcp

# Custom extension ID for development
mearl-native-host --init --extension-id <your-extension-id>
```

> Skills and MCP hosts use the same binary and share one Unix socket, so both can be enabled.

You can also invoke the installer in code:

```typescript
import { installNativeHost } from '@mearl/native-host';

await installNativeHost(); // Register both modes by default
```

The runtime entry, launched by browsers or manually, is exported through a subpath:

```typescript
import '@mearl/native-host/runtime';
```

## CLI options

```bash
mearl-native-host [options]

  --init [--mode <skills|mcp|both>] [--extension-id <id>]   Register host manifests
  --daemon                                                Standalone CDP daemon
  --cdp-port <port>                                        CDP port
  --cdp-user-data-dir <dir>                                Chrome profile
  --cdp-endpoint-file <path>                               File containing private remote CDP WebSocket URL
  --skip-browser-registration                             Do not expose Provider-private CDP as a separate browser
  --browser-id <id>                                        Browser registration ID
  --browser-name <name>                                    Browser display name
  --version, -v                                           Show version
  --help, -h                                              Show help
```

Daemon arguments apply only to the current process. Client-started discovery daemons first read the default Chrome profile's `DevToolsActivePort`, then probe local CDP port 9222. Custom ports/browser identities must be supplied on each manual startup. Discovery uses its own instance Socket rather than depending on ownership of a fixed Socket.

Electron apps exposing renderer CDP can also connect with `--daemon --cdp-port <port> --browser-id <id> --browser-name <name>`. Select the instance with `browser_list` and an existing window with `tab_list`, then perform page actions. This does not cover native menus, system dialogs, or main-process `--inspect` debugging. See `mearl guide browsers` for connection steps.

Chrome authorization mode enabled at `chrome://inspect/#remote-debugging` disables HTTP discovery. If `DevToolsActivePort` is missing/unreadable and `/json/version` returns 404, Mearl connects to `/devtools/browser` WebSocket on the same port and waits for Chrome authorization. Allow the browser prompt. This path reads no browser profile files. Failures retain discovery-file read errors to distinguish filesystem permissions, ports, and authorization issues.

## Architecture

On macOS, extension connections first inspect the Native Messaging host's direct parent application's bundle ID to distinguish EgoLite, Chrome, and Edge, including supported test channels. Results cache per host process. Identification does not guess from page UA, application directory names, or browser versions, so device/App simulation does not change names. Other systems, unknown applications, and read failures retain extension-reported names. Names support display/selection, not page association, ownership, or authorization.

```
Chrome Extension
  ↓ (Native Messaging)
@mearl/native-host  ← CDP →  Chrome
  ↓ (Unix Socket)
@mearl/client  /  @mearl/cloud-connector
```

`browser_launch` starts a native-host child with independent CDP configuration for each managed Chrome, making concurrent headless/profile instances addressable in the browser registry. External Providers may reuse generic page actions through private remote CDP. Providers still own remote credentials, lifecycle, and file staging.

## Sidebar Agent Chat

The extension sidebar calls native-host through Native Messaging, then starts persistent Codex app-server or installed Agent-capability processes according to user selection. Providers support streaming messages, reasoning/tool progress, interruption, and approval, reusing CLI sign-in sessions.

Install and sign into a standalone Codex CLI or Codex App supporting `app-server`. native-host searches the installation-time Node executable directory, common global directories, version managers, `PATH`, and Codex App's bundled runtime, validates compatibility concurrently, and selects the newest semantic version. Automatic selection caches within the process; explicit paths always win:

```bash
MEARL_CODEX_PATH=/absolute/path/to/codex
```

The Agent Chat setup screen installs missing Codex or Qoder components through npm under `~/.mearl/agent-programs`. For Qoder, the local Agent adapter comes from [`@mearl/plugin-qoder`](../plugin-qoder/README.en.md). A Qoder adapter supplied by the selected preset takes precedence. The menu installation leaves the preset selection intact and enables the local Agent only.

## Plugin host capabilities

The plugin host manages commands, tasks, page instances, events, models, and state. Toolbox, CLI, SDK, MCP, and Agent are entry points; tool-page lifetime does not determine background capability lifetime. Protocols evolve with tools without legacy interface adapters.

### Ownership and identity

- Execution environments have persistent `hostId` and per-process `epoch`. hostId lives in the plugin registry directory and identifies environments without granting permissions.
- Each environment's user-level execution service owns tasks/executors. Browser Native Hosts adapt connections and targets. Browser targets and model execution locations are independently selected and pinned after launch, unaffected by default-browser changes.
- Commands have `invocationId`, source, plugin, and optional parent invocation. Trusted entries construct context; business input cannot replace it. Nested calls inherit host/source and receive new invocation IDs.
- Installation IDs, logical names, and immutable code revisions are separate. Tasks/page instances pin revisions; updates affect new execution only. Active work completes, drains, or stops by policy. Complete source snapshots include local dependencies; entry metadata cannot substitute for revisions.

### Command executors

Handlers receive `(input, context)` with `identity`, `signal`, `invoke`, and `progress`, expiring after execution. JS plugins are trusted native code. Executor isolation enables scheduling and termination, not an OS permission sandbox.

`executeRegisteredPlugin` creates a supervisor and business child for each call; Python entries bridge through the business executor to Python children. Supervisors independently watch host connections, so blocked business code cannot prevent owner-disconnect cleanup. Parent hosts handle browser/Agent calls. cwd/environment inherit from the execution host. Public commands and tool-page allowlists validate separately; source labels grant no authorization. Python registration and terminal results require host ACK before exit. Hosts settle on process exit and release parent pipes, so descendant-inherited stdio cannot block completion. Python processes surviving acknowledged terminal results get one second to exit before forced termination; supervisors must still confirm full-tree cleanup.

```typescript
await executeRegisteredPlugin('example', { command: 'read', input }, hostContext, {
  signal: controller.signal,
  executionTimeoutMs: 120000,
  onProgress: progress => updateProgress(progress),
});
```

Wait timeouts, execution deadlines, caller disconnects, and cancellation are separate. Cancellation notifies executors, then terminates after a grace period; stopped status requires confirmed exit. Already received successful results take precedence over later cancellation. Stops return pending host-action names for external reconciliation. Returning without awaiting host calls fails explicitly.

Executors retain process ownership after submitting results; parent hosts clean up after receipt: POSIX process groups are reaped, and Windows runs `taskkill /T` while supervisors remain alive. Independent supervisors handle owner disconnects. Unconfirmed cleanup reports `PLUGIN_EXECUTOR_CLEANUP_FAILED`. Local termination cannot undo operations submitted to external services.

Results submit completely through a separate JSON channel, limited to 64 MiB with explicit overflow failure. Diagnostics may truncate, but final business results cannot be reconstructed from truncated events. Task results persist as separate JSON resources; Native Messaging transfers Base64 chunks of at most 192 KiB raw bytes, with total-length and SHA-256 verification.

### Tasks and model execution

Task services provide `start/get/list/events/subscribe/wait/cancel/result`, unified statuses, and increasing event sequences. States distinguish queued, running, cancelling, succeeded, failed, cancelled, and interrupted. Records/terminal states persist; progress is bounded. Unfinished generations become interrupted after restart without redoing external operations. Parent/child model tasks share cancellation and terminal cleanup. Commands may declare checkpoints and explicit recovery.

User-level services use exclusive ownership and execution leases; multiple browser processes do not concurrently write one task store. Services own checkpoints; plugins declare recovery entries and revision-migration requirements. Long results use owned, checksummed, expiring resources with lossless chunked reads.

Services partition by plugin registry directory and listen on local Unix sockets/Windows named pipes. Sockets/data files are current-user-only. Leases record PID, OS process creation identity, protocol version, hostId, and epoch. Startup locks prevent duplicate launches; stop waits for executor cleanup and lease release. Protocol mismatches require stopping the old service rather than silently connecting.

Task acceptance pins cwd, environment, installation ID, source revision, and browser route. Environment is child-only and never persisted. Source and relative resources become content-hashed read-only snapshots. Static JS import/require must target Node built-ins or snapshot-relative files; external packages must be bundled. Escaping/missing dependencies reject before acceptance. Snapshots exclude node_modules and do not freeze system programs, Python packages, or dynamically resolved external dependencies. Named plugin calls remain host dependencies resolved at call time. Source changes or reinstall after removal create new installation IDs.

Default concurrency is 4 with 128 queued tasks. Limits: input 256 KiB, individual progress 64 KiB, history 256 entries/512 KiB. Events include cursors, gap indicators, and latest task snapshots. Lists bound pages/bytes and return nextCursor. Terminal tasks/results remain seven days, cleaned hourly while resident along with unreferenced revisions.

CLI/SDK/MCP can query local tasks. Tool pages see only their own plugin's toolbox/runtime tasks, not public-entry tasks. Toolbox browser calls bind original Native Host connections and survive tool-page closure. Lost browser connections interrupt calls explicitly without switching windows; purely local work is independent. Public background browser tasks require explicit targets, resolved to stable browserId before acceptance. Execution cannot override browser/connector/session/transport/local.

Explicit idempotencyKey deduplicates within installation/entry scope; changed input, revision, routing, environment, or deadline conflicts. Toolbox coalesces identical active requests on the same Native Host. Repeating an action after completion creates a new task. Wait timeout/unsubscribe stops observation only; execution cancellation requires cancel.

```typescript
const tasks = new PluginTaskClient();
try {
  const task = await tasks.start('example', { command: 'read', input: { path: 'document.txt' } }, { executionTimeoutMs: 120000 });
  const result = await tasks.wait(task.taskId, { timeoutMs: 30000 });
} finally { tasks.disconnect(); }
```

Tasks execute on the entry point's local service, with hostId-bearing IDs. Foreign-host IDs reject without broadcast queries. Plugins expose business commands and relevant progress/cancel/recovery actions. CLI/MCP use those entries without generic task, model, state, page-instance, or host-diagnostic tools.

Models persist as `kind: model` tasks sharing events, cancellation, lossless results, and retention. Commands default to concurrency 4, models 2, each with 128 queued, so commands waiting on child models do not block model scheduling. `app.model(request)` / `context.model(request)` create child tasks; parent cancellation/end first cleans children. Synchronous entries propagate signals too. Model deadlines default to 120 seconds. Executors own independent Provider processes and confirm tree termination before terminal cancellation.

`capabilities` reports actually supported modes, permissions, structured output, streaming, and cancellation. Codex currently supports only explicit `{ provider: 'codex', mode: 'agent', permissions: 'read-only' }`. Each call uses a temporary app-server session with configured MCP, Apps, search, plugins, and related extensions disabled; sandboxes forbid writes/network and approval requests fail immediately. Read-only Agent file access remains, so tool-free execution is not promised. `mode: 'generate'` rejects explicitly without fallback. Interactive sidebar sessions remain independent.

Requests are limited to 256 KiB; `outputSchema` to 64 KiB, passed through [Codex app-server](https://developers.openai.com/codex/app-server/) `turn/start`. Hosts accept only successful turns' original final messages, parse JSON, then mark tasks successful. Providers enforce outputSchema; plugins validate final structure/business constraints. willRetry errors do not end execution early; terminal errors retain causes and stable codes. Optional `model.delta` diagnostics cannot be concatenated into final results. Final text is limited to 32 MiB, returning `{ text, output?, provider, mode, model? }`; plugins validate additional business constraints.

SDK uses `PluginModelClient.capabilities/list/start/run`; toolbox uses `host.model.capabilities/list/start` and `waitTask`. `PluginModelClient.run` signals cancel execution and await cleanup, unlike task `wait`, which stops observation only.

### Checkpoints and explicit recovery

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

`context.checkpoint(data, expectedSequence)` is available only in active managed public commands with service routing and no page-instance binding. Children may checkpoint, but explicit recovery accepts eligible roots only. Payloads are limited to 64 KiB. Hosts check JSON/CAS sequences and assign increasing checkpoint numbers; schemas describe format/version identity, while plugins validate data. Data, versions, canonical host schemaHash, task snapshots, and checkpoint events share one atomic record. Stale writes conflict explicitly. Checkpoints neither prove external completion nor share state-transaction commits. Recovery handlers close external-submit/checkpoint failure windows by querying operations or using stable idempotency keys.

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

migrateFrom allows up to 16 distinct versions below the target. Historical schemas must match checkpoint host hashes and retained declarations. Dynamic declaration drift rejects recovery even with unchanged source. Migration/recovery recheck target signatures before hidden handlers; normal checkpoint writes validate executing declarations; Python validates full metadata before each ready ACK. Migration returns new checkpoint data. Hosts validate JSON, the 64 KiB limit, and target identity, then atomically save data/provenance in the unique successor, leaving original tasks/checkpoints unchanged. Missing migrations, mismatched formats, conversion failures, and unconfirmed cleanup reject acceptance.

Concurrent recovery of one source task coalesces by revision choice and environment fingerprint; different intents conflict. Retries of committed successors verify request fingerprints without rerunning conversion. Migration runs in an independent managed process with a 10-second limit, sharing an eight-process budget with declaration parsing and no wait queue. Service shutdown cancels it and waits for cleanup. Acceptance requires confirmed termination of both conversion and original execution trees, plus revalidation of installation and both source snapshots. Migration has no host APIs, models, state, pages, or nested plugin calls. JS/Python remains trusted native code with direct file/network access, not an OS sandbox. Migration must be repeatable pure JSON conversion: crashes before commit may rerun it, with no exactly-once guarantee.

Recovery currently supports root commands with public entries and stable service-owned routes only. Toolbox/Native Host caller routes, page bindings, models, and child tasks explicitly reject recovery because their lifecycle cannot be inferred from an old task. Before acceptance, the host recursively checks supervising processes, OS creation identities, and POSIX groups for the task and all descendants. Running execution or unconfirmed cleanup rejects recovery; uncertain ownership records do not expire away. Windows also rejects recovery after service crashes without full process-tree termination proof. Recovery handlers can explicitly request models as new executions.

### Page runtimes and events

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

Event schemas describe formats; background handlers validate payloads, while hosts check bindings, document ownership, sizes, and scheduling. Payloads are limited to 32 KiB; page pending-ack queues to 64. Background pending defaults to 32 per event (maximum 64), active events to 128 per instance, concurrency to 8. History holds 256 entries/384 KiB with explicit cursor gaps. Native Messaging chunks requests/results at 192 KiB with SHA-256 checks. Page messages/results allow 24 MiB; browser/toolbox reply resources each share 32 MiB and expire after 30 seconds.

SDK uses `PluginPageClient`; toolbox uses `host.page.*` or `window.mearl.subscribe('page', { instanceId, cursor? }, listener)`. `events` accepts `cursor` and `waitMs` (0–25000). Toolbox reads an initial snapshot then long-polls; unsubscribe stops observation only. Internal `page_runtime` adapts documents; plugins use `app.page()`. Design overlays save assets through page events.

Explicitly configure activation through `app.page('activation', { enabled: true, matches, persistence: 'session' | 'persistent', frame, input })`. Effective scope is the intersection of user rules and declarations. Automatic instances recheck it at injection, SPA navigation, and regular validation, invalidating when outside scope. Manual attachment follows declarations. Disabling rules cleans instances; rule generations block in-flight stale attaches. After extension worker restart, handshake with the execution service verifies hostId, service epoch, installation, revision, browserSessionId, documentId, and instanceId. The same owner resumes unacknowledged events from the service's received position, which only advances. Connection epochs do not change business event sequences. Temporary bridge outages retain queues for reconciliation until lease expiry.

To change matching scope independently, pass `enabled: true, matchPatch: { add?: string[], remove?: string[] }`, mutually exclusive with `matches`. Hosts atomically add/remove scopes to avoid concurrent overwrites. Removing the final scope disables automatic activation while retaining manually attached instances. `persistence: 'persistent'` survives browser restarts. Initialization handlers can read current plugin preferences instead of copying volatile settings into rule input.

Service epoch changes, missing instances, or regressed receipt positions invalidate old instances and queues without replaying events into a new service. Existing activation rules can create new instances; manual instances require attach again. Rules bind installation IDs, so uninstalling or changing source does not transfer authorization to same-name replacements. Injection serializes handoff in an isolated script world, awaiting old handler dispose before creating a new instance so old overlays cannot remove new DOM.

### State and activation

Schemas are format metadata; hosts do not evaluate JSON Schema keywords. Plugins validate state writes, event payloads, checkpoints, and migrations. Plugins export `stateStorage = { version: 1, collections: { ... } }`. Collections declare `scope` (installation/host/browser-session/instance), `storage` (persistent/cache/memory), `schemaVersion`, JSON Schema, and optional `maxEntries/maxBytes/ttlMs`. Browser-session/instance accept only cache/memory; memory supports only these scopes and lives in execution-host memory, allocated on demand with a host-wide 128 MiB/512-namespace limit. Restart clears it; instance end releases it. Browser-session state survives refresh but separates browser sessions. Real active pages determine scopes, never forged business fields. Instance end cleans dedicated caches; other caches default to one-day TTL, maximum seven days, reclaimed on reads, maintenance, and quotas. Settings, caches, tasks, and binary assets are separate.

If a namespace already has state, switching between memory and disk requires a new collection name or scope. Cross-medium migration is unsupported.

`get/list/transact` serialize in the user-level task service. Values, CAS versions, schema versions, TTLs, and the latest 64 idempotency receipts persist in one atomic record. Each put/delete requires the opaque `expectedVersion` obtained by reading. Collection versions increase monotonically and are never reused after deletion or expiry. Multi-key transactions allow 128 operations and 512 KiB; single values 256 KiB. Collections default to 1024 entries / 8 MiB, with disk state limited to 64 MiB per plugin. memory uses the host-wide limit above. list is bounded and paginated; callers use `expectedRevision` to detect changes between pages.

Changing schema/storage requires increasing `schemaVersion`. Migration transactions supply `migrateFromVersion` and `expectedRevision`. Plugins validate and transform retained values; hosts check versions/transaction constraints and atomically commit. Old revisions cannot write new schemas. Synchronous handlers verify load-time declaration signatures against update races. Replacement installations never inherit old namespaces.

Commands use `app.state(collection, operation, input)` or current-instance-bound `context.state(...)`. SDK `PluginStateClient` and toolbox `host.state.*` share the service. Design overlay assets/settings use browser-session memory with bounded chunked asset access. Explicitly exported user images are not cache.

Plugins declare available URL scopes and activation entries. User rules control enablement, matching, and cross-restart persistence. Activation maintains page instances; explicit invocation or events trigger business commands. Extension, browser, and execution-service restarts reconcile instances and tasks through handshakes to prevent duplicate recovery.

Toolbox background commands use `host.task.*`. Ordinary synchronous commands run in calling processes; background commands use managed executors. Long-lived resources persist through state, files, or resource channels.

When user-initiated toolbox attach lacks target-site permission, the host permission dialog is reused; approval retries only undispatched resolve. Heartbeats, instance messages, and background events never prompt or replay potentially effective operations. Extension reload is a host operation independent of the current page's domain grant.

### Cross-plugin calls

Managed `app.invoke(name, { command, input })` creates an independent child task pinned to the child installation/revision with its own state/model/page/checkpoint ownership. Children can call only public commands, without hidden toolbox/runtime permissions. Cycles and depth over 16 fail explicitly. Parent cancellation, expiry, or completion cancels and awaits the child tree. Children cannot change browser routes. Page-bound calls inherit document constraints and must explicitly attach their own instances under their own pageRuntime, never borrowing parent instances or controlling other documents. Children can checkpoint, but explicit resume remains eligible-root-only.

### Unified diagnostics

`PluginTaskClient.diagnose()` and toolbox `host.task.diagnose` read one metadata report. taskId/plugin/instanceId filters intersect; caller scope filters before expanding parent/child/recovery relationships. Toolbox stays restricted to its plugin, including relationships. Diagnostics start no models, send no browser requests, and change no page bindings.

Reports link hostId/epoch, task/parent/resume, invocation, installation/revision, and document/instance. Model records include runtime choice, base configuration sources, observed authentication types, requested/configured/actually rerouted models, and acknowledged thread/turn limits. Base config/read does not establish final thread configuration. Missing notifications/history retain unknown/incomplete, without inferring accounts, credentials, or outcomes. Unavailable executable versions are omitted.

Defaults exclude input, prompts, progress/checkpoint/result bodies, full URLs, environment, and credentials. Errors include code only; executable paths retain basenames only. Explicit includeErrorMessages/includeLocalPaths permits bounded messages/local paths, never error details/metadata/stack. CLI exports use 0600 permissions. Limits: 256 KiB, 128 tasks, 64 pages, latest eight non-progress events per task; scans cap at 2048 directory entries, 512 records, and 16 MiB. coverage distinguishes incomplete scans from output omissions; history.gap reports retained-history gaps.

Executor states distinguish unstarted, currently observed alive, positively confirmed whole-tree stopped, and unknown. Terminal task status does not imply stopped execution. Page service-snapshot is the service's current record; historical-binding is execution-time identity. Neither guarantees the browser remains at that document.

### Public interfaces

| Capability | SDK | CLI | MCP | Toolbox |
| --- | --- | --- | --- | --- |
| Persistent tasks, results, cancellation, checkpoint recovery | PluginTaskClient | Plugin-defined business commands | plugin_invoke | host.task.start/get/list/events/result/cancel (SDK initiates checkpoint recovery) |
| Diagnostic export | tasks.diagnose | — | — | host.task.diagnose |
| Fixed-document runtimes and activation | PluginPageClient | Plugin business commands | plugin_invoke | host.page.* |
| Transactional state | PluginStateClient | Plugin business commands | plugin_invoke | host.state.* |
| Managed models | PluginModelClient | Plugin business commands | plugin_invoke | host.model.* |

JS/Python plugins compose these capabilities with context state/model/checkpoint and app.invoke. Synchronous commands run in calling processes; managed cross-plugin calls use separate child executors. Do not keep long-lived page resources in command processes. Wait timeouts stop observation; execution deadlines/cancel terminate trees. Commands/models have separate slots; parents waiting for children release slots and reacquire before continuing, with at most 32 waiting parents. In-memory active-child indexes let finalization cancel/wait only its children without scanning retained history; restart recovery still validates persisted trees.

## Build and validation

```bash
pnpm build      # esbuild into dist/, inlining browser-core / daemon-core
pnpm typecheck  # Type checking only
```

## License

Apache-2.0

Query models through SDK `PluginModelClient.list()` or toolbox `host.model.list`. Entries include supported `reasoningEfforts` and `defaultReasoningEffort` where available; UI restricts choices accordingly. Hosts coalesce discovery, immediately return existing catalogs, and refresh stale data in background. Failures retain usable catalogs with short backoff and create no inference sessions. Batch state reads use `get-many` and `keys` (SDK `getMany`, toolbox `host.state.getMany`) for up to 128 keys at one revision, including missing keys' CAS versions, limited to 1 MiB.


`PluginHost` assembles `tasks/state/pages/models`, shutdown ordering, and diagnostics. Task schedulers own execution, parent/child calls, cancellation, and recovery, accessing state/pages through injected services. Models remain tasks with independent scheduling quotas and host-shared catalogs. Hosts explicitly wire page-instance state-scope resolution. `PluginHostConnection` shares RPC transport; Native Host caches connections separately by plugin, interaction channel, and source so sharing cannot change permission prompts.
