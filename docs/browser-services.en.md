# Browser background capabilities

[简体中文](browser-services.md) | [English](browser-services.en.md)

Capability packages declare background handlers through `contributions.browserRuntimes.extension`, using existing bundle digests, quotas, and offline storage. Page runtimes provide synchronous startup bridges; background capabilities provide asynchronous UI operations. Both work independently of Native Host after installation.

Operations and public logins are declared in JSON referenced by `contributions.extension`: `{ schemaVersion: 1, operations?, logins? }`. References below to `extension.operations/logins` mean the host's merged display structure. Preset `defaults.extension` supplies configuration defaults. See the [capability model](capability-model.en.md) for contracts and examples.

```json
{
  "appProfiles": [],
  "browserRuntimes": {
    "extension": {
      "entry": "runtime.cjs",
      "bindings": { "request.apiSchema": "apiSchema" }
    }
  }
}
```

The entry is self-contained CommonJS exporting `factory(host, config)` and returning its own function table. Handler names must match declarations. Node, arbitrary imports, and extension APIs are unavailable. Factory initialization only creates handlers; browser operations belong inside handlers.

Configuration-driven UI operations capture one validated installation snapshot at acceptance, sharing configuration, service defaults, and handler selection. Explicit user switches remain live; network and Cookie operations still check current domain authorization and Chrome permissions. Installation validates all UI contributions; request-detail reads select only their own contributions.

`prepareBrowserBundleSnapshot` selects modules, configuration, and bindings for a browser host, verifies digests, and rejects duplicate hooks. Node declarations are excluded. Calls capture code and input at acceptance; updates cannot alter ongoing operations. Factory instances are per-call; UI controllers own drafts and caches.

Popup startup settings include display metadata for installed browser App simulation, so quick settings can show simulation choices on first expansion. The full catalog loads only after menu expansion; opening Popup does not wake Native Host early. Catalog failures retain installed entries, preset switches discard stale catalog responses, and enablement remains live.

`buildBrowserCapabilityPage` generates documents for the extension's bundled sandbox page, without evaluating code in the Service Worker. Documents block direct network access and request host `request` and `cookie` services through a private MessageChannel. Hosts validate active calls, senders, current domain authorization, and Chrome permissions, manage temporary headers/Cookies, and clean up afterward. Extension deadlines are 30 seconds for initialization and 120 seconds for ordinary calls; sandbox startup fails after 15 seconds. Expiry closes frames/ports, releases calls, and aborts pending requests. Requests stop at the first redirect by default, reporting `redirected: true` so modules preserve login prompts. Operations needing page fetch behavior may explicitly use `redirect: 'follow'`; subsequent targets remain permission-bound.

Installation hosts validate the complete binding set and candidate factories before activation. `BrowserBundleStore.install`'s third argument and `activatePreset`'s fifth argument accept the full validated `revisions` set. IndexedDB commits compare it again to prevent concurrent installs under different IDs from bypassing hook-conflict checks. Factory failures, confirmation failures, or changed revision sets preserve the old selection. Status queries validate resources and bindings without running factories.

`request({ withCookies: true })` reuses host Cookie collection. Set `withSourceHeaders: true` for source/CSRF headers. The extension reuses DNR source policy to generate Origin, Referer, and XSRF headers present in collected Cookies, matching full URL domains and paths and including ordinary and target-site first-party-partition Cookies. Same-name Cookies remain and are sent in descending path-length order. `withXsrf: false` keeps source/Cookie headers but omits automatic XSRF. Explicit `injectedHeaders` override defaults case-insensitively. Requests without a selected source policy keep declared headers.

`request.formBody` accepts string key/value pairs. Hosts construct multipart FormData and its boundary; this is mutually exclusive with raw `body`. Modules need not construct or transport browser objects in sandboxes. Field names, empty values, and Unicode are preserved.

With `withCookies: true`, `cookieHeaders` maps nonempty Cookies into headers, for example `{ "x-csrf-token": "csrfToken" }`. Cookies and derived headers come from one collection to avoid mismatched reads. Explicit `injectedHeaders` takes priority.

`request` defaults to `credentials: 'omit'`. Operations relying on browser-default credentials may explicitly use `credentials: 'same-origin'`. Targets still undergo the same permission checks.

Response `headers` use lowercase names for standard HTTP processing such as Content-Type. `cookie({ withRelatedCookies: true })` uses the same URL matching and partition selection as requests; otherwise the original URL-specific Cookie query remains.

`request({ cache: 'no-store' })` disables caching for both ordinary and redirect-following requests. Omission uses browser defaults.

Each UI operation owns a separate runtime port. Cancellation, document exit, or worker disconnection aborts requests, destroys sandboxes, and releases leases. offscreen creates iframes only after the worker confirms an owner connection, preventing late sandbox creation after preparation cancellation. Existing long-lived views and capture controllers retain their own lifecycles.

## Skill catalog

`extension.operations['skills.catalog']` can declare a same-name browser hook accepting `describe`, `search`, and `markdown`. describe returns `available`, `managerId`, `title`, and `homeUrl`; search returns UI Skill metadata plus `pageUrl` and optional explicit `installSource`. Catalogs do not install anything or require Native Host.

The UI captures the provider revision from describe and pins that implementation/configuration for search and preview. The public catalog is used only when no catalog is declared or describe explicitly returns `available: false`. Selected-catalog authentication, network, protocol, or resource errors display directly without switching sources. Preset updates cancel old requests while retaining search terms and install scope; installed Skills' local details remain.

The default public catalog supplies bundled Mearl Skills offline. Community search uses the official Skills catalog; previews read exact GitHub file blobs. A unique same-name directory first verifies frontmatter; other cases bound candidate scanning and reject ambiguity. Rate limits and read failures retain an Open original page entry.

The extension integrates request metadata, service switches, loading, and error UI, showing contribution slots according to installed definitions. Packages supply background business behavior. Installation views share host installation status.

## Inline request-detail contributions

`contributions.requestUi` references same-package JSON up to 64 KiB. `selectBrowserRequestUi` purely validates the graph, rejects multiple providers, and requires detail and optional save hooks to belong to the package's browser background declarations. Resources describe fixed request links, detail toggles/two-line content, service switches, and login-dialog slots. Hosts render components and manage drafts, caches, and interaction without interpreting arbitrary layouts.

Definitions contain `schemaVersion: 1`, `service`, `setting`, `apiLink`, `login`, and `details`. Text uses `{ en, zh_CN? }`. `browserUiText` selects translations; `browserRequestUiLink` generates links from declared fixed and API/version parameters; `browserRequestLoginError` matches original login-error fragments. URLs must use HTTPS or loopback HTTP without credentials or fragments. `validateBrowserRequestDetail` checks display text, links, and optional owner details. Business packages transform platform responses into display values.

Optional `save: { hook, setting }` connects the inline save control to a same-package handler. `setting` follows service-switch key constraints. Hosts check the selected revision and switch per call; selected-handler failures never silently choose another implementation. Hosts retain buttons, search dropdowns, Portals, focus, and feedback; packages handle platform queries and save parameters. Each candidate retains provider identity across updates so old query results cannot be saved by a new provider. Inline save appears only when the contribution declares `save`.

Hosts validate reserved setting keys before activation to prevent collisions with other services or core settings. Calls bind accepted bundle/revision. Provider changes invalidate old requests, and stale errors cannot trigger a new provider's login. Installation events arriving during asynchronous validation require another read to prevent stale UI definitions.

Extension hosts retain service-setting slots and layout. Before opening login, establish a document lifecycle connection and pin the accepted definition. Background tracks accepted origins; same-origin documents share rules. Closing, document exit, or exit during submission cleans that document's record; the final record releases rules. Explicit release does not depend on permission-service availability. After background restart, UI reconnects the same record. Open login definitions do not change with package updates. This private UI lifecycle adds no public Agent/MCP tools.

## Streaming connections for views

`contributions.browserViews.captureLauncher` occupies the capture-launcher slot and is selected and conflict-checked independently of `requestImport` and `requestCases`. It may be UI-only with empty `actions`, without access to other packages' background handlers. Hosts share the current capture session, identity, and selections through context and limited callbacks while controllers retain proxy and cleanup ownership. Launcher and session executor load separately; capture may continue after the launcher closes.

`BrowserViewDefinition.transports` declares up to 16 named connections, such as `{ "events": { "kind": "eventSource", "setting": "captureEnabled" } }`, with `kind` restricted to `websocket` or `eventSource` and each bound to an existing service switch. Views call private bridge `transport.open({ id, name, url })` / `transport.close({ id })` and receive `source: 'transport'` events through `onEvent`. Events include connection ID, type, and readyState; messages retain data, origin, lastEventId; WebSocket closure retains code, reason, wasClean. The contract supports open, default messages, errors, and close, not sending or named SSE subscriptions.

Hosts resolve connection types from accepted declarations and check switches, current domain selection, and Chrome host permissions on every open. `browserTransportUrl` validates URLs; WebSockets check permissions through corresponding HTTP(S) URLs. `browserTransportPolicies` generates two independent CSP connect-src policies for user selection and Chrome grants. The extension applies both in a dedicated iframe before opening native connections. Dynamic views still cannot access the network directly. Native EventSource retains reconnection, Last-Event-ID, and authorized redirects; WebSocket retains browser redirect restrictions.

Ordinary-view connections belong to that open view; persistent-controller connections belong to their owner document. Lifecycle end, service/domain-setting changes, or Chrome permission removal releases them. Pending authorization cannot recreate connections late; stale same-ID results cannot close replacements. Background-worker restart does not destroy surviving view connections. No Native Host is required. Views and controllers use declared transport types.

HTTP CSP sources also allow HTTPS upgrades. To keep SSE redirects within Chrome grants, HTTP opens only when both HTTP and HTTPS are authorized for the same host scope; HTTP-only grants are rejected. Hosts normally use paired `*://host/*` permissions. Other authorization models must preserve equivalent redirect constraints rather than checking only the initial URL.

Extension documents still render logins. For dialogs within transformed containing blocks, internal adapters pass bounded rectangle positions; hosts validate viewport bounds and reproduce the containing block. Measurements refresh after resize and window animation. Login preparation retains the latest rectangle, releasing observers and leases on close. Without a containing block, login uses the viewport. Outer host dialogs may temporarily own Esc to prevent propagation into dynamic windows behind them.

## Capture session executors

`contributions.browserViews.captureController` is an independent capture-session slot with same-package actions, preferences, and transport validation. Code runs in an opaque iframe without direct networking. `window.mearlView.handle(method, handler)` registers host-callable commands and returns an unregister function. Async values and errors return over the private MessagePort. Duplicate registration is rejected; stale unregister functions cannot remove newer handlers. This adds no Chrome APIs or Agent/MCP tools.

The extension runs accepted executors in offscreen documents, pinning HTML, background code, and declarations. After stopping ordinary command acceptance, it waits for in-flight commands, calls and awaits `dispose`, then releases iframe and acceptance records. Proxy acquisition, rules, and cleanup survive launcher closure. A subsequent session in the same document waits for prior cleanup before querying/acquiring proxies. Worker restarts restore authorization through document identity and persisted acceptance records; offscreen's owner connection can wake background for cleanup after UI closure.

Browser background forwards only declared operations, preferences, and authorized native connections; offscreen uses runtime messages only. SSO, one-shot factories, and persistent sessions share offscreen leases, so worker-local counts cannot destroy other active tasks. Accepted cleanup code can finish after provider uninstall. Cleanup-only handlers must be limited to release/delete and cannot bypass service switches for ordinary operations. Controller acceptance pins the candidate version only on success; pre-acceptance version changes can refresh and retry.

Hosts render the launcher, request list, and details. Packages declare handlers using request transformation, response modification, and capture hooks. Browser execution works independently of Native Host.


## Reusable pure-computation sandboxes

`buildBrowserPureCapabilityPage` validates digests, UTF-8, declarations, and configuration and embeds only code, handler declarations, and configuration. Arguments travel through separate MessagePorts, never reusable HTML. Factories initialize once; numbered calls correlate results. `request` and `cookie` always fail and CSP forbids networking.

The extension keys instances by content/configuration digests, allowing 64 in-flight calls per instance. A 15-second startup or 10-second call timeout destroys the instance and rejects in-flight work. At most 16 instances are kept; only idle ones are evicted. After 60 idle seconds, iframe and offscreen lease release. Workers accepting the same code may reuse surviving instances; reclaimed instances rebuild once using accepted bytes. Pure instances cannot inherit network/Cookie permissions from ordinary factories. Hosts needing Cookies check URL permissions first and explicitly pass necessary data.




## Tracking parser integration

`tracking.decode` receives ordered request inputs: `url`, optional `body`, `options: { now, sequence }`, and `locale`, returning `{ tracking, events }` per row. Unparseable rows return their own `error` while others succeed; factory, runtime, or result-structure failures fail the whole call. `tracking.spm` applies only to historical events lacking position metadata. Parsers may return `point: { mainSpm, highlightSpm }`; detail views use that accepted result while preserving original event fields.

The extension pins implementation and inputs when accepting requests. Requests in one round batch up to 32 rows and 16 MiB; individual rows still obey runtime input quotas. Batches use pure instances serially instead of creating a sandbox per request. Installation changes affect new requests; accepted requests and later missing-body lookups retain original code.

Background capture assigns sequences before asynchronous parsing and commits in acceptance order. Cursors stop before uncommitted requests; queries wait only for the current queue snapshot. Stopping, clearing, or changing capture sources invalidates old results. Format errors log diagnostics and event gaps; module failures also record request gaps. HTTP/log history remains readable; event queries explicitly report module failure, and later successful parsing may recover the session.




## Page queries and synchronous links

Page queries needing automatic redirects use `request({ redirect: 'follow' })` to retain native fetch credentials, status, headers, POST redirect semantics, and JSON results. The extension uses its existing connection page and applies two connect-src policies in each request frame for Agent domain selection and Chrome grants. Initial URLs still pass background authorization. HTTP opens only with corresponding HTTP/HTTPS grants to constrain automatic CSP upgrades. Default `manual` operations retain login detection.

Before execution, establish the caller port and offscreen handshake. Only requests with owners can create frames. Cancellation, revocation, background exit, or deadline aborts fetch and releases frame, port, and offscreen lease. Follow mode returns the final response; `redirected` reports actual redirects, letting callers handle final status/body.

`defaults.extension.linkTemplates` supplies named fixed-destination links, such as `trace: { template, title: { en, zh_CN? } }`. Variables are permitted only in query or fragment and individually encoded as data, never replacing origin or path. Trace links accept `traceId`, `startTime`, and `endTime`. Templates plus local data complete clicks synchronously without awaiting plugin networking. Missing destinations retain the raw ID.

Metadata queries invoke installed operations whose handlers define arguments and results. Caches key to accepted capability snapshots; changed parameters or selections discard stale responses. `identity.panel` supplies UI identity; `capture.identity` accepts `source: "full"` for complete profiles. `extension.logins.capture` configures login; `CAPTURE_LOGIN_REQUIRED` requests sign-in.

Identity results use `{ subject: string, displayName?: string, complete: boolean, ...claims }`. `subject` determines sign-in, `displayName` is display text, and `complete` indicates profile completeness. Hosts pass other claims unchanged and request completion before saving incomplete profiles.

Metadata components submit query values, leaving identity resolution to handlers. Identity caches and requests are Preset-session scoped; switches discard stale results and document broadcasts. Login windows use lifecycle leases. Accepted embedded UI stays until close; next opening uses the current session.



Account badges retain login dialogs, account borrowing, list refresh, and mobile QR codes. Generic hosts consume only `accounts` operations. Packages own platform paths, identity fields, paging, borrow parameters, ticket policies, login-page detection, and fallback QR URLs. `extension.logins.accounts` supplies login/portal URLs, with document-owned leases for opening and closing.

`extension.operations.accounts` binds handlers for `list`, `borrow`, `sso`, `qr`, `normalize`, `current`, and `loginContext`. Lists return `accountList`, `totalNum`, and `pagedNum`; records use `id`, `principalId`, `loginId`, `site`, and optional `ownerName`/`status`. `qr` returns `{ url, alternateUrl? }`. `loginContext` returns `{ supported, selector?, redirectUrl? }`; hosts retain countdown, cancellation, and return navigation.

`extension.operations.accountIdentity` independently reads identity, returning `{ value, watch: [{ name, domain }] }` for current-identity display and Cookie monitoring. Hosts bind account records and identity caches to the executing bundle/revision. Same-bundle updates revalidate caches using the new `normalize` pinned to its revision; ticket and business operations remain pinned to acceptance revisions. Preset switches discard old results; failed ownership validation hides records while retaining caches. `normalize` may accept `legacyIdentity` and return extra `identity` only after the package recognizes record ownership, for initial cache recovery. Public hosts contain no platform field recognition or compatibility rules.

Confirmed empty identities or `ACCOUNT_LOGIN_REQUIRED` synchronously invalidate local name snapshots and background name-restoration eligibility, preventing old-name flashes on later Popup opening. The last account identifier remains for automatic login; name caches return only after valid identity confirmation. Network errors and incomplete identity responses are not sign-out. Probes order requests by storage scope so stale results cannot restore invalidated display state.

`logs.share` supplies HTTPS links for log sharing. Handlers define parameters/results; hosts validate links and offer copying. Failures display errors while retaining the action.

`links.manual`, `links.agentDocs`, and `links.skillSetup` configure help entry points, defaulting to repository documentation. Login prompts substitute validated URL hostnames into translations. Skill installation prompts use standard `skills` CLI.

Service switches are `accountsEnabled`, `requestCasesEnabled`, `requestMetadataEnabled`, `requestImportEnabled`, and `trackingMetadataEnabled`. Installed capability defaults reach UI through session `{ services }` snapshots; user preferences win. Preference changes and default refreshes share a serial queue. Custom request-metadata settings use the same write path and validate current selection at commit.

Account login policy comes from `accounts.sso`. Hosts validate returned HTTPS destinations, domain authorization, and Chrome permissions, then execute in document-owned iframes. Preset permissions cover both origins and destinations.

Environment switching uses integrity-checked local JSON referenced by `contributions.browserControls`. It defines a native `schemaVersion: 1`, `kind: "segmented"` quick control with `id`, English/Chinese `label` / `description`, `defaultValue`, `messages.changed` / `messages.failed`, and `options`. Options contain `value`, `label`, and `networkRoutes: { routes: [{ id?: "api", fromHost: "api.example.test", toHost: "qa.example.test" }] }`. The default option must clear routes. Capabilities supply names, gateways, and business text. A preset graph allows one provider.

Hosts validate exact DNS names, duplicate sources, resource/rule sizes, and destination permissions. Selection binds package/revision and saves rules and the complete accepted plan per tab, rolling back failed writes. document_start MAIN rewriting and later iframe CORS share the snapshot. Preset updates or worker restarts do not reinterpret selections; reselecting the same option accepts a new plan. Menu placement, sizing, fetch/XHR/JSONP interception, and manual-refresh behavior remain, without native-host. Accepted rules can still be cleared after provider removal.

The environment control appears when a package supplies these standard resources.

`browserControls` and generic capture identity fields are coordinated 3.x development protocols. Integrate matching 3.x SDK, extension, and capability builds.

iframe origin reports only expand accepted configurations. Running documents pin accepted mappings. Clicking the same target again accepts current configuration and prompts a refresh. Session rules survive worker restarts; failed writes restore complete old rules. CORS destinations expand from accepted configuration within authorization scope.

`extension.accountState` may declare `{ cacheKey, identityKey }` to reuse account caches. Keys must share a namespace as `<namespace>-accounts-cache` and `<namespace>-last-<field>-id`. Hosts reject other setting keys and cross-namespace pairs. Omission uses public defaults. Capability or key changes reread the matching cache; UI neither displays nor writes other-key data before reads finish.

Capture controllers declare supported channels through `state.channels`, with `label`, `supportsModify`, `connection`, `overrides`, and optional `onlineMocks`. IDs use at most 64 lowercase letters, digits, and hyphens; hosts do not enumerate platforms. Commands are `<id>.setOverride`, `removeOverride`, `removeAllOverrides`, `reconnect`, and `disconnect`; online mocks may offer `refreshOnlineMocks` / `cleanOnlineMock`. `prepareOverride` validates capability-specific imports before modification; failure retains the user's modification toggle. Controllers maintain all channels concurrently; pages subscribe to the accepted channel. With no available selection, use and save the controller's first channel.

`extension.captureState.namespace` supplies a shared prefix for capture switches, request submodes, and list widths, combined only with fixed host role suffixes, without arbitrary settings access. Omission uses defaults. Generic capture-proxy context carries proxy selection and connection lifecycle; `logins.captureProxy` supplies the platform login URL and title.

Request cases, import, metadata, and heatmaps use generic entry points. `extension.messages` may override service names, buttons, and prompts. Heatmaps bind `tracking.heatmap`. Saving requests may read the case view's application preference only when explicitly local `appKey` belongs to the same metadata bundle/revision; session preferences are never read from Chrome local. Ordinary preferences use package/slot namespaces; shared editor preferences use the limited `shared` contract.
