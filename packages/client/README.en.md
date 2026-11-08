# @mearl/client

[简体中文](README.md) | [English](README.en.md)

Use `mearl` in a terminal or `@mearl/client` in TypeScript to control browsers, inspect requests and logs, or run Skill commands. The CLI, SDK, and script runner share browser routing and plugin runtimes. `@mearl/setup` manages installation and connections.

Run `mearl guide` for the core workflow in this version; `mearl guide --list` lists topics. For example, `mearl guide run` covers SDK composition and `mearl guide environment` covers devices/Apps. Guides read bundled npm resources without browser connections, plugin loading, installation, or automatic updates. Use `mearl <action> --help` for arguments and existing catalogs for installed target capabilities.

Guide content is maintained only in this package's `guides/`, copied to `dist/guides/` at build time, and checked by `pnpm check:skills`. CLI output converts local document links into guide commands. `skills/mearl/` distributes only a compact `SKILL.md`, without guide copies. MCP-only clients unable to run CLI use current tool descriptions/schemas.

A unified browser SDK and CLI discovering browsers on this machine and all connectors under configured cloud-server instances. Global `browserId` from `browser_list` selects local Socket or cloud WebSocket routing automatically.

Use type-safe named methods such as `getRequests` and `sendRequest`, or the flexible low-level `invoke(action, payload)`.

## Installation

```bash
npm install @mearl/client
# Or
pnpm add @mearl/client
```

## SDK usage

```typescript
import * as client from '@mearl/client';

// Type-safe named methods
const requests = await client.getRequests({ tabId: 12345, count: 5 });
const result = await client.sendRequest({
  url: 'https://api.example.com',
  method: 'GET',
  withCookies: true,
});

// Flexible low-level invocation
const data = await client.invoke('send_request', { url: '...' });

// browser_list aggregates local and all remote connectors by default
const browsers = await client.browserList();
await client.getLogs({ tabId: 12345 }, { browser: browsers.browsers[0].browserId });
```

## CLI usage

Installation provides the `mearl` command:

```bash
# Get the five latest requests
mearl get_requests --payload '{"tabId":12345,"count":5}'

# Proxy an HTTP request
mearl send_request --payload '{"url":"https://api.example.com","method":"GET"}'

# Upload a local file with multipart/form-data
mearl send_request --payload '{"url":"https://api.example.com/upload","method":"POST","formData":{"folder":"assets"},"files":[{"fieldName":"file","filePath":"/absolute/path/image.png"}]}'

# Save a screenshot; tabId comes from tab_open or tab_list
mearl page_screenshot --payload '{"tabId":12345}' --output ./screenshot.png

# Read large parameters from a file; mock-data.json must include tabId
mearl set_mock --payload-file ./mock-data.json

# Check the environment
mearl check
mearl check --local --json

# Update the local environment
npx @mearl/setup update --local

# Show action help
mearl <action> --help

# Launch isolated headless Chrome instances
mearl browser_launch --payload '{"name":"browser-a","url":"https://example.com"}'
mearl browser_launch --payload '{"name":"browser-b","persistent":true}'
mearl browser_launch --payload '{"name":"cookie-copy","copyCookieDomains":["example.com"]}'
mearl browser_launch --payload '{"name":"figma","userAgentMode":"desktop","copyCookieDomains":["figma.com"]}'
mearl browser_list
mearl browser_release
```

### Agent scripts

`mearl run` reads JavaScript from stdin or `--file <path>`, injects the `mearl` SDK, and supports top-level `await`, conditions, loops, and data processing without task-directory dependencies:

```bash
mearl run --session new <<'JS'
const tab = await mearl.tabOpen({ url: 'https://example.com', reuse: 'prefer' });
console.log({ tabId: tab.tabId, session: mearl.session });
console.log(await mearl.pageSnapshot({ tabId: tab.tabId, mode: 'viewport' }));
JS

mearl run --session '<sessionId>' --file /absolute/path/next-step.mjs
```

Method names match the SDK, such as `mearl.pageClick(params, options?)`, `mearl.getRequests(params, options?)`,
and `mearl.tabList(options?)`. Use `mearl.invoke(action, payload, options?)` for generic calls.
Arguments/results match ordinary actions; consult `mearl <action> --help`. Action failures still use `action.success`,
`stage`, and `attempt`; scripts decide subsequent logic. Print needed results with `console.log` and diagnostics with `console.error`.
Returned data is not printed automatically. `run_actions` fits tight sequences without decisions; scripts fit workflows whose results code can evaluate.
When a model must interpret the page, print minimal observations and continue in the next round.

Scripts query command definitions through `help` and print returned text as needed. CLI `--help` shares arguments, results, constraints, and examples.

```javascript
console.log(await mearl.help()); // Methods and registered plugins
console.log(await mearl.help('pageClick')); // Also accepts page_click
console.log(await mearl.help({ plugin: 'notes', command: 'search' }));

const result = await mearl.invokePlugin('notes', { command: 'search', input: { query: 'project' } });
console.log(mearl.structure(result));
```

`structure(value, options?)` synchronously extracts an existing result's structure, replacing leaves with types. Defaults: depth 5, 50 keys per object,
one sample per array, 2000 total nodes. Adjust with `maxDepth`, `maxKeys`, `arraySamples`, and `maxNodes`.
Output includes array lengths/samples and marks cycles, accessors, and limits. Samples need not cover all optional fields or heterogeneous elements;
command help defines business meaning. The ordinary SDK also exports `structure`, sharing extraction logic with request `keysOnly`.
`keysOnly` follows the same default key/node limits and marks truncation.
Plugin help loads registration in isolated processes without executing the queried business command.

Compose registered Skill commands using names and inputs from plugin `--help`:

```javascript
const result = await mearl.invokePlugin('notes', {
  command: 'search',
  input: { query: 'project' },
});
console.log(result);
```

Browser APIs and plugin calls inherit script `--browser`, `--session`, `--connector`, `--local`, and `--cdp`;
individual `options` may override them. `--server` selects cloud-server. After `--session new` establishes a session,
later calls use its returned ID automatically; `mearl.session` and CLI stderr report session information.
First await a session-establishing browser call before concurrency or Skill commands. Script completion disconnects SDK connections but retains control sessions;
explicitly call `mearl.browserRelease` according to task lifetime. JavaScript variables reset each round; continue with returned `sessionId` and `tabId`.

Scripts run in separate Node.js processes inheriting caller cwd/environment with host Node.js permissions;
they are not security sandboxes. Load modules through dynamic imports such as `await import('node:fs/promises')`.
`--file` also executes as a script function without static `import` / `export`. Prefer absolute file URLs for local modules.
`window` / `document` exist only in page expressions through `mearl.pageEval`. Plugin registries, local files, and authentication belong to the CLI host.

`--timeout <seconds>` limits the complete script, default 60 seconds. API `options.timeoutSec` limits individual calls.
Combined stdout/stderr allows 256 KiB; source allows 1 MiB. Await every SDK call. Missing await, timeout, cancellation, or script exceptions exit 1;
input errors exit 2. Cancellation/timeouts stop scripts and process groups and propagate signals to pending Skill calls. Dispatched browser/business operations may still take effect;
use `pendingActions` / `mayHaveLateEffects` to determine reconciliation needs, without directly rerunning the entire script.
Skill commands use existing isolated executors; their stdout/stderr counts toward the script limit. Exception diagnostics are also bounded.
Result `success` means normal script completion only. Code must check action and business outcomes.

SDK hosts can import `executeScript(code, options)` from `@mearl/client/script`, returning
`{ success, stdout, stderr, session?, error?, executionStopped, mayHaveLateEffects, pendingActions }`。
It supports `signal` cancellation and `executionTimeoutSec`, sharing executors with CLI/MCP.

### Control sessions and files

For multi-step tasks, use `--session new` on the first `tab_open` or `page_snapshot`. The response adds `session` alongside ordinary results; later `sessionId` routes automatically without separate creation/query actions. Sessions bind one browser/transport and associate pages on first use, tracking reused and created pages separately. One session controls a page at a time; sessionless calls cannot bypass ownership. Sessions do not isolate Cookies/storage.

`sessionId` is a short ID such as `s_aB3d_E-f`. The resident control host keeps sessions/browser/transport mappings in memory. New CLI processes internally query local/remote hosts for routing, without caller-managed routing or mapping files. Control-host exit invalidates sessions.

Calls may omit `--session`; existing actions, `run_actions`, and upload `filePaths` remain available. With active sessions, sessionless calls cannot manipulate owned pages, release/close browsers, or modify shared settings. Opening pages/closing browsers inside sessionless batches requires separate calls. CDP mocks are tab-scoped and must be configured per tab.

```bash
mearl tab_open --session new --payload '{"url":"https://example.com"}'
mearl page_snapshot --session '<sessionId>' --payload '{"tabId":12345}'
mearl browser_control --session '<sessionId>' --payload '{"operation":"handoff","reason":"Please scan the QR code"}'
mearl page_download --session '<sessionId>' --payload '{"tabId":12345,"trigger":{"selector":"#export"}}' --output /absolute/path/report.csv
mearl page_upload --session '<sessionId>' --payload '{"tabId":12345,"selector":"input[type=file]","files":[{"filePath":"/absolute/path/report.csv"}]}'
mearl browser_release --session '<sessionId>' --payload '{"closeCreatedTabs":true,"keepTabIds":[12345]}'
```

Users take over, return, or end sessions in Popup browser management. Handoff stops queued stale requests and later batch steps; dispatched actions may still apply. Take a fresh snapshot after return. CDP-only environments can use the same `browser_control` with `operation:"resume"` after explicit user confirmation. Sessions survive CLI connections, expire on host exit, and are not idle-cleaned while users work.

New extension background tabs join a collapsed `Mearl` group; foreground tabs join the expanded `Mearl · 待操作` group. Both reuse one existing window and merge same-name managed groups. Subsequent opened tabs enter that window and inherit source-group expansion. Closing the work window selects another existing window without creating one. Explicit `tab_open.group` overrides grouping; reused ordinary pages retain windows/groups. Handoff moves only managed session pages into the pending group; return moves those still pending into `Mearl`. Groups remain expanded if users view other grouped pages or the window has no other visible page.

Session release affects only that session and keeps pages/environments by default. `closeCreatedTabs` closes only created pages; `keepTabIds` retains results. Reused user pages always remain. `preserveEnvironment:false` clears those pages' environment. Active sessions block browser-wide release/close.

`page_download` listens before clicking and returns a browser artifact. CLI `--output` or SDK `saveArtifact(artifact, absolutePath, { session })` exports in 256 KiB chunks. `page_upload.files` accepts caller absolute `{filePath}` or browser `{artifactId}`; `filePaths` remains browser-host paths. Files are limited to 256 MiB. Caller-saved outputs are independent of temporary artifacts. Session release cleans temporary artifacts; `keepArtifactIds` retains selected ones. Sessionless artifacts expire after one idle hour; host exit clears staging.

Extension downloads require matching page referrers or an explicit expected `url`; unowned downloads are not guessed from recent files. CDP uses temporary directories only for managed browsers; shared browsers retain defaults and fail explicitly if Chrome provides no completed path. Timeouts may follow triggered downloads: inspect state before continuing. Session/download adapters support Extension/CDP; external action-handling Providers reject unsupported capabilities explicitly.

### External browser Providers

Provider browsers appear beside Extension/CDP browsers in `browser_list` and use the same
global `browserId` routing. `@mearl/setup` manages installation, updates, and removal:

```bash
npx @mearl/setup provider install @example/mearl-provider-device

# Inspect this Provider version's capabilities, arguments, and workflow
mearl example-device --help

# Provider launch arguments use providerOptions
mearl browser_launch --payload '{"provider":"example-device","providerOptions":{}}'
mearl browser_list

# Use global Browser IDs returned by browser_list for later operations
mearl tab_list --browser '<browserId>'
mearl page_snapshot --payload '{"tabId":12345}' --browser '<browserId>'

npx @mearl/setup provider update example-device
npx @mearl/setup provider uninstall example-device
```

Creating a `pairing` instance with `browser_launch` returns `pairing.url` and an optional pairing code. Agents should render the URL directly as
a QR code, then confirm the same Browser ID becomes `connected` before page operations. Until the device connects,
it cannot become the default target. Use `browser_close` to delete the Provider instance. Each Provider
receives only explicitly supported actions; screenshot support distinguishes native captures, reconstructed images, and unsupported.

Unknown or misspelled actions return up to three candidates and examples based on available commands/common aliases,
without connecting to browsers or executing suggestions. For example, `mearl tab new` prefers `mearl tab_open`.

**Common options:**

| Option | Description |
| ------------------------ | ------------------------ |
| `--payload <json>` | JSON arguments |
| `--payload-file <path>` | Read JSON from a file |
| `--timeout <seconds>` | Request timeout |
| `--compact` | Force compact stdout |
| `--output <path>` | Save output, such as screenshots |
| `--browser <id\|name>` | Target browser |

CLI, SDK, and MCP share return structures. Snapshot `@eN` refs are directly actionable; internal mappings remain runtime-local.
Ordinary `session` includes session ID, browser, transport, state, and generation. Query tabs with `tab_list`;
`browser_control` handoff also returns session `tabs`. `run_actions` steps preserve individual action results.
stdout defaults to compact JSON in pipes/redirection and pretty output in interactive terminals. `--compact` forces compact layout without changing values. Snapshots collapse unnamed, stateless groups without refs while preserving control states and text.

With nonempty `fields`, `get_requests` omits request/response bodies by default, returning extracted fields and metadata;
pass `includeBody:true` for full bodies too. Omitted bodies exclude `postData` / `responseBody`;
without field selection, bodies are returned by default.

`send_request` includes ordinary Cookies matching the full target URL and CHIPS Cookies for its first-party site. For example, `https://app.example.com/` uses the `https://example.com` partition independently of open pages. Sites use schemes and the public suffix list including private suffixes, excluding other sites/schemes, cross-site ancestors, and opaque partitions. Same-name Cookies on different paths remain; parent-site host-only Cookies are not added. Third-party partitions embedded elsewhere, page signatures, or complete page identities require requests through the target page's `page_eval`.
Response `Set-Cookie` updates the original browser for later calls; `withCookies:false` disables both automatic inclusion and writeback. Chrome handles extension response Cookies. CDP Node requests write back through the original browser connection before returning, supporting HttpOnly, default paths, expiry, and deletion. CDP responses with `Set-Cookie` include `cookieSync: { updatedCount, rejectedCount, failedCount }` without values. Partitioned Cookies with unknown partitions count as rejected. Sync failures cannot undo completed HTTP operations: inspect state rather than resending business requests. Ordinary/streaming Protocol requests use the same refresh mechanism.
Extension temporary credentials match only the original full request URL; Chrome selects redirect Cookies for the new URL. CDP Node requests, including Protocol streams, do not automatically follow redirects, preventing original Cookies/signatures from reaching other addresses.

Mearl aggregates local and configured cloud-server browsers by default, routing automatically with global
`browserId` from `browser_list`. The overrides below restrict hosts/connections or troubleshoot transport, so default help omits them:

| Option | Description |
| ------------------------ | ------------------------------------- |
| `--connector <id\|name>` | Restrict to one remote machine |
| `--local` | Current machine only |
| `--cdp` | Force local CDP; list only CDP browsers and imply `--local` |
| `--server <url>` | Override the automatically read cloud-server URL |

`browser_list --help` and `browser_launch --help` show scenario-specific host options. For connection/transport troubleshooting, use
`mearl check --help`. `mearl check` checks connection/browser status. `mearl check --updates` also concurrently queries
latest client, native-host, cloud-connector, and extension releases. Release queries wait about 1.5 seconds at most;
unreachable sources report unconfirmed updates without affecting browser checks. `--json` returns machine-readable results,
including updates when combined with `--updates`. Available updates show appropriate commands: client/native-host use
`npx @mearl/setup update`; setup-managed extensions use `npx @mearl/setup extension`.

By default, globally installed `mearl` launches an independent background updater after the first use each day to query releases and compare
installed client, native-host, cloud-server, and MCP server versions. When needed, it invokes
`@mearl/setup update --yes --skip-skill` for outdated environments and their shared client, including standalone CLI installations.
The current command waits for neither network nor installation. Outcomes persist in
`~/.mearl/cli-auto-update-state.json`. Project dependencies and temporary `npx` copies are not modified automatically.
The browser extension retains its separate update entry.
Configure the interval or disable updates in `~/.mearl/config.json`:

```json
{ "cliAutoUpdate": { "intervalDays": 7 } }
```

```json
{ "cliAutoUpdate": false }
```

Intervals use local calendar days. Run `mearl check --updates` for immediate release checks.

## Skill plugins

Install a Skill and automatically register commands, or register an existing entry:

```bash
npx @mearl/setup plugin install https://github.com/mearlhq/mearl --skill browser-tab-manager --yes
npx @mearl/setup plugin /absolute/path/to/browser-tab-manager
npx @mearl/setup plugin uninstall tabs
mearl tabs summary
mearl tabs --payload '{"command":"summary","input":{}}'
mearl tabs --help
mearl tabs --version
```

If a plugin and Provider share a name, `mearl <name> --help` shows Provider launch/lifecycle guidance first,
then appends registered plugin commands. `mearl <name> <command> --help` retains detailed command help.
Providers/plugins install, update, and uninstall independently. Help aggregation starts no Providers and executes no business commands.

Directories default to `scripts/main.mjs` or `scripts/main.py`, preferring JavaScript if both exist. JavaScript default-exports `register(app)`; Python exports a `register(app)` function. Both may declare short `name`/`description` metadata and use `app.command(signature, handler, description?)`
to register actions, `app.invoke(action, payload, options?)` for current-browser context, and `app.progress(message)` for progress. JS may pass `{ message, data }` with JSON-serializable stage/object metadata for tools; CLI shows only `message`. Python `app.invoke` is synchronous; handlers may be ordinary functions or `async def`. Python requires `python3 >= 3.9`, optionally selected by `MEARL_PYTHON`; Mearl neither installs Python nor runs pip. Cross-plugin payloads use `{ command, input }`, inheriting host options and rejecting cycles. CLI prints final results only unless
`--verbose` writes progress to stderr. Handlers return text/JSON; hosts manage `--output`, connections, and errors. User-invoked writes execute directly; business modules validate targets, state, idempotency, and outcomes.
Names prefer explicit registration, then entry `name`, then Skill directory. Normal registration needs only a path.
setup supplies missing client/native-host versions or upgrades those older than itself. Its Skills installer handles arguments using global shared installation.

JavaScript entries may export `setup({ runCommand })` to prepare Skill-owned dependencies. Both setup installation paths await this hook before registration; failures stop registration. Help, entry loading and ordinary calls do not execute it. Skills check their own dependencies on first use. Runtime code and resources belong inside the Skill.

For isolated checks, run `mearl <name> --version`. It resolves registration and loads the entry without browser connections;
exit 0 means registered/loadable. stdout shows the adjacent `SKILL.md` version or `unknown` without metadata.
Missing registration/entry or loading errors exit 2 with `PLUGIN_*`. Ordinary calls can handle these directly without a precheck.

Plugins accept positional arguments, string business options, or `--payload` with command/input. Prefer
`--name=value`; `--name value` is also supported. Fields match handler input independent of order. One field cannot use both
positional and business options; `--payload` cannot mix with either. JSON preserves field types. File/body inputs follow each
Skill's contract. Host options such as `browser`, `timeout`, and `output` keep their meaning. Same-name business fields, numbers,
booleans, objects, and arrays use `--payload`. Plugins do not use built-in actions' `--payload-file` entry.
Business option names begin with a letter and contain letters, digits, or underscores, preserving underscores.

Registered plugins are also SDK-callable; instance `client.invokePlugin` reuses connections/default browsers:

```typescript
import { invokePlugin } from '@mearl/client';

const result = await invokePlugin(
  'tabs',
  { command: 'summary', input: {} },
  { browser: 'work' },
);
```

MCP uses fixed `plugin_invoke` with `plugin`, `command`, and `input`. SDK/MCP use registered plugins. The installation-host-managed catalog may trigger setup matching the client version and one retry; other unregistered names return `PLUGIN_NOT_REGISTERED`.

Long commands use auto-starting local persistent task services isolated by registry directory. CLI/SDK/MCP/toolbox share records; caller exit does not cancel execution. Restart marks unfinished work `interrupted` without replay. Background tasks pin accepted source snapshots, cwd, and environment. Bundle third-party JS dependencies into Skills and keep state outside source directories. Snapshots pin source/relative resources without pre-resolving JS dependencies; executors report missing dependencies/syntax errors on load.

```ts
import { PluginTaskClient } from '@mearl/client';

const tasks = new PluginTaskClient();
try {
  const accepted = await tasks.start('example', { command: 'search', input: {} }, {
    executionTimeoutMs: 120000,
    idempotencyKey: 'document-123',
  });
  const result = await tasks.wait(accepted.taskId, { timeoutMs: 30000 });
  console.log(result);
} finally {
  tasks.disconnect();
}
```

`wait` timeout or signal abort ends waiting only; `cancel(taskId)` cancels execution. Browser tasks require explicit `browser`, resolved to fixed IDs before acceptance. `get/list` return snapshots/result references; `list` has bounded pagination/`nextCursor`; `events` provides cursors, gaps, and snapshots; `subscribe` wraps long polling. `result(taskId)` losslessly reads and verifies chunks up to 64 MiB. Terminal records/results remain seven days.

Handshakes and `tasks.status()` return `version/buildId`; build IDs identify running code, while protocol versions determine compatibility. With matching protocols, different/missing version/build IDs do not interrupt tasks, models, pages, or state. To switch builds, confirm no active tasks/page operations, call `tasks.stopHost()`, and let the next business call start the current build. Reregistration does not restart services. After local client/host changes, root `pnpm build` generates matching fingerprints and both artifacts; `tsc --watch` alone does not.

SDK `PluginTaskClient` and toolbox `host.task.*` expose tasks. Plugins provide business commands through `mearl <plugin> <command>` or MCP `plugin_invoke`; there are no separate global task/model/state/page/diagnostic CLI/MCP tools. Toolbox-only plugins are absent from CLI lists; invoking their name shows where to open the tool. Tool pages use `window.mearl.waitTask(taskId)`, `readTaskResult(taskId)`, and `listTasks()` only for their own toolbox tasks.

`tasks.diagnose({ taskId?, plugin?, instanceId?, includeErrorMessages?, includeLocalPaths? })` reads bounded diagnostics within caller scope. Defaults exclude input, prompts, progress/checkpoint/result bodies, full URLs, environment, credentials, errors, and local paths. Error messages/paths may be explicitly included. coverage/history gaps describe collection and retention limits.

Records at `~/.mearl/plugins/<name>.json` save entry paths/optional descriptions. In-place business-code edits apply directly; path/description changes require registration again.
`plugin uninstall <name>` globally removes Skills under `~/.agents/skills` through the Skills installer,
then clears registrations, including tracking cleanup when entry directories were manually deleted.
Manual paths unregister without source deletion.
`PLUGIN_NOT_REGISTERED` means no registration. `PLUGIN_ENTRY_MISSING` shows the stale path and a cleanup
command with the actual plugin name. Other failures retain their specific cause.
The following sections describe toolbox, page, state, and task contracts.

Plugins may export `toolbox`, appearing in extension Popup after registration. Resources live within the Skill directory. Registration
inlines local CSS, JavaScript, and images referenced by entry HTML into an immutable page bundle, without HTTP services
or requiring builds for ordinary HTML/CSS/JS pages.

Right-click tools to enable/disable their Skills individually. Disabled status appears beside titles; tool pages/commands remain usable. Disabling renames
`SKILL.md` to `SKILL.md.mearl-disabled`, restored on enablement, affecting every Agent sharing that directory.
Symlink installs affect source directories. Existing sessions may retain loaded Skills until Agent restart/new sessions.
Toolbox updates/reinstalls preserve disabled state; external installers do not. Duplicate manifests require conflict resolution first.
Independent copies of same-name Skills disable separately. Plugins without Skill manifests show no toggle.

Example toolbox metadata:

```javascript
export const toolbox = {
  version: 1,
  title: 'Workspace Notes',
  description: 'Organize notes for a workspace',
  icon: 'notebook-pen',
  locales: {
    en: {
      title: 'Workspace Notes',
      description: 'Organize notes for a workspace',
    },
  },
  agent: {
    skill: 'notebook-skill',
    layout: 'workspace',
  },
  page: {
    type: 'sandbox',
    runtime: 'preact',
    entry: 'assets/toolbox/index.html',
    commands: ['list', 'create', 'delete'],
  },
  order: 100,
};

export default function register(app) {
  app.command('list', async () => ({ items: await listItems() }));
  app.command('create <name>', async input => ({ item: await createItem(input.name) }));
  app.command('delete <id>', async input => ({ item: await deleteItem(input.id) }));
}
```

`app.command(signature, handler, description?, examples?)` registers business commands for CLI, SDK, and Agent.

Set `toolbox.agent.pageElementActions` to `false` to hide page element selection and commenting in the toolbox's Agent chat. These actions are shown by default.

`toolbox.icon` supports the following strings, shared by tool lists, switch menus, and website catalogs:

```js
icon: 'git-branch' // Built-in icon, at most 40 characters, follows theme
icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/></svg>' // Monochrome SVG follows theme and interaction
icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#2563eb" d="M4 4h16v16H4z"/></svg>'
icon: 'https://example.com/tool-icon.svg' // HTTP(S) image URL, including SVG and PNG
icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'
```

Icon strings allow 32768 characters. SVG using `currentColor` renders as a monochrome mask, inheriting built-in theme/hover/selection colors; prefer `fill="none" stroke="currentColor"` for outlines. Explicitly colored SVGs, multicolor data URLs, and remote images retain colors. SVG never injects into extension DOM. Remote images omit referrers; credentialed URLs are rejected. Unknown names/load failures show generic icons. Relative file paths are unsupported.

`app.toolboxCommand(signature, handler, description?, examples?)` registers tool-page-only commands with the same parameter/handler contract;
they do not appear in CLI help and cannot be called by CLI (including JSON), SDK, MCP, or cross-plugin `app.invoke`.
Tool pages use `window.mearl.invoke(command, input)` or `window.mearl.invoke('host.task.start', { command, input })`. Both command types must be explicitly listed in `toolbox.page.commands`.
Registered toolboxCommands absent from that allowlist fail plugin loading. Use them for chunked uploads/reads and temporary page-resource release;
use `app.command` for complete operations independently useful to Agents, such as queries, import, compression, or comparison.
Python also supports `app.toolboxCommand(...)` and `@app.toolboxCommand(..., description="...")` decorators.

Declaring `agent` lets tools delegate tasks to the conversational Agent. `layout` defaults to `drawer`, with a host-provided top entry.
Pages may select `drawer` / `workspace` / `inline` per interaction through `setAgentPanelVisible` or `runAgentTask`.
Agent conversations persist in Codex history. Workbenches with a fixed
18rem left navigation can default to `workspace`, switch Agent through navigation, and fill the remaining main area; detail pages can still open right drawers.
`inline` embeds the Agent in a card/section, requiring an `anchor` element and stable
`key`. Hosts track anchor scrolling/resizing. `key` also isolates conversations and drafts by business object in drawer/workspace layouts;
`setAgentPanelVisible` may pass absolute `cwd` to bind newly created conversations to a directory.
`context` supplies background information without showing it as a chat message. On the first user message and session creation,
it is delivered as developer instructions.

`await window.mearl.ready()` returns `{ locale, theme, title, fontSize }`. Use
`window.mearl.invoke(command, input?)` for same-plugin allowlisted commands. Pages run in sandbox iframes without extension
APIs or network access by default. Native Host validates identity, command allowlists, and message size. Page bundles use
content-hash caches and chunked transfer without increasing Popup startup cost. Module scripts must first bundle into one file without
`import`. React/Vue projects may use built `index.html` as `entry`; registration performs final packaging.
For build-free components/state, declare `page.runtime: 'preact'`. After integrity checks, extensions inject pinned
Preact, Hooks, and HTM. Read `html`, `render`, `useState`, etc. from `window.mearl.ui`.
`window.mearl.ui.version` is diagnostic only; plugins cannot select runtime versions.
Hosts synchronize theme/font size and inject semantic variables including `--mearl-bg-primary`, `--mearl-bg-secondary`,
`--mearl-text-primary`, `--mearl-text-secondary`, `--mearl-border`, `--mearl-bg-hover`, and
`--mearl-accent`. Primary buttons use `--mearl-action-primary`,
`--mearl-action-primary-hover`, and `--mearl-action-primary-text` to match extension controls.

Toolboxes serve people; CLI serves Agents. Reuse business operations and consistent results without requiring shared intermediate state. Drafts, selections, previews, and other UI state default to browser memory. Use browser storage only for concrete refresh/reopen recovery needs. Sandboxes cannot assume localStorage, IndexedDB, or chrome.storage; use host capabilities. Node state is for business records, tasks continuing after close, safe retry receipts, or message-limited resource staging, with explicit lifetimes/cleanup.

Skill plugins can provide custom requests/data processing. CLI uses `mearl <plugin> <command>`; plugins reuse operations with `app.invoke(plugin, { command, input })`. Skill contracts define names, authentication, fields, and uploads.

Node plugins execute on the CLI/SDK/MCP Server host, never forwarded with browsers/connectors. File paths belong to that host. Browser operations require explicit targets. Installation hosts may provide on-demand installation through capability catalogs.

## Supported actions

| Category | Actions |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| API debugging | `tab_checkpoint` `get_requests` `get_logs` `get_events` |
| Mocks and rules | `set_mock` `get_mocks` `set_rule` `get_rules` |
| Network requests | `send_request` `request_permission` |
| Tabs | `tab_open` `tab_list` `tab_close` |
| Page observation | `page_snapshot` `page_inspect` `page_screenshot` `page_frames` |
| Page actions | `page_click` `page_drag` `page_type` `page_hover` `page_scroll` `page_press` `page_wait` `page_navigate` `page_upload` `page_eval` |
| Page runtimes | `page_runtime` (internal document adapter; plugins use `app.page`) |
| Composition | `run_actions` |
| Environment and Cookies | `set_device_emulation` `set_app_profile` `set_timezone` `get_cookie` `set_cookie` |
| Browsers | `browser_list` `browser_launch` `browser_release` `browser_close` |

Interactive actions (`page_click` / `page_drag` / `page_type` / `page_hover` / `page_scroll` / `page_press` / `page_upload`) wait for asynchronous stability by default and return `{ action, observation }`. Pre-dispatch argument/ref/target failures return `action.stage: "precondition"`, omitting meaningless observation/diagnostics. Potentially dispatched input with confirmation timeout returns `action.stage: "dispatch-uncertain"` and observations for reconciliation. Known targets, hits, coordinates, dispatch modes, and input sequences appear in `action.attempt` as diagnostic evidence, not proof of effect. CLI failures exit 1. `observe: false` performs bare actions; `diagnostics: true` collects new error logs/business requests during the action, with analytics optionally enabled through `diagnostics.events`. `page_eval` defaults to bare execution and permits observation/diagnostics.

`tab_open active:true` requests activation. Extension do-not-disturb defaults on: HTTP(S) pages get background-focus emulation before first navigation without switching tabs/windows. Disabling it activates/restores windows. `activation.mode` distinguishes `background` / `foreground`; emulated visibilityState does not prove foreground. Handoff, release, and disconnect disable focus emulation regardless of preserveEnvironment. After return, reactivate the same URL with `reuse:"require", active:true` if needed. Sessionless tasks finish with browser_release. Pure CDP/external Providers follow their own activation support. Stability observation waits for bounded-duration CSS animations within budget. Selector/ref clicks first scroll targets clipped by nested containers, failing explicitly only if still clipped.

In extension mode, `tab_open` with `appProfile` applies the App environment. Set `emulation.deviceShell` to `true` for the simulated WebView and system bars. On supported fixed devices with a single WebView, the extension applies the saved **Phone frame** preference from Quick Settings. Agent page actions target the active business WebView.

Default `page_click` auto uses DOM fallback on hidden pages, supporting selectors, text, refs, and coordinates and returning `dispatchMode: "dom"`, `fallbackReason: "page-hidden"`. Ordinary background tasks need no activation for clicks. Only sites rejecting untrusted events require visible pages and forced `mouse` / `touch`.

`observation.effects.interactives` marks controls `recreated` when frameworks replace DOM nodes without content changes. It retains selectors/refs/semantics but omits unchanged values/states. Actual value/state changes still return full differences.

Optional `observation.effects.texts` returns current visible leaf text as `{ selector, text }`, including counters/amounts outside controls. Limits: eight entries, 160 characters each; repeated node changes retain final values. Nonempty text Range rectangles must be entirely within viewport/ancestor clipping and pass hit testing. CSS-masked text is excluded; empty text uses element boxes. These are neither interactive controls nor business-success signals. Complex/unreadable content and budget overflow retain snapshot fallback without changing navigation waits.

`page_press.pressMode` accepts `auto` / `dom` / `keyboard`. Default auto uses DOM key events on hidden pages, reporting `dispatchMode`, `fallbackReason`, and simulated `defaultAction`. Use visible pages and keyboard for native editing, selection, or scrolling.

`page_snapshot` defaults to full AX Tree. Use `mode: "viewport"` for long lists, `"interactive"` for viewport controls, or explicit `"dom"` when AX is empty/sparse. DOM returns rendered text, native controls, explicit roles, and high-confidence clickable nodes with actionable `@ref`, without inferring arbitrary business semantics. Scope with `rootSelector` or `rootRef` (optionally ancestorDepth), and search text/roles with query. interactive lacking AX control semantics falls back only to AX viewport with `fallbackMode: "viewport"`, never automatically switching sources. `maxNodes` / `maxChars` truncation preserves both beginning and end.

`page_inspect` uses CSS, snapshot `@ref`, or DevTools `$0` to return counts, bounding boxes, selected computed styles, center occlusion, horizontal/vertical overflow pixels, and nearest scroll containers. Omit selectors with `filter: "horizontal-overflow"` / `"vertical-overflow"` / `"scrollable"` for page-wide diagnosis. For text, first get `matches` / `matchCount` and refs through `page_snapshot.query`, then inspect refs without custom page_eval.

Disambiguate repeated text through `page_click.scope` CSS/ref subtrees. Extension coordinates in containers/iframes use `coordinateSpace: "active-frame"`; CSS/text queries accept frameId. Results distinguish requested semantics, resolved DOM, dispatch node, trusted hit, and coordinates through `requestedTarget`, `resolvedTarget`, `dispatchTarget`, `hitTarget`, and `coordinates`. Nested-clipped selector/ref targets scroll into view automatically; only remaining overflow clipping requires explicit handling. `page_scroll.containerPolicy: "nearest"` selects the nearest scrollable ancestor. Without selector, scrolling first chooses an inner container hit at representative viewport positions, then document scrolling or the topmost largest-visible container.

`browser_list` lists ordinary, Provider, and managed browsers. `type` distinguishes
`regular` / `managed`; `status` distinguishes `connected` / `pairing` / `running_disconnected` /
`stopped`. Only connected browsers are ordinary operation targets. Without a connected local extension browser,
browser_list automatically probes default CDP, even with Provider pairing records, without requiring --cdp.
`browser_list --cdp` actively probes if no ordinary CDP browser is registered and returns CDP browsers only;
connected extension browsers do not prevent this probe. With `MEARL_SOCKET_PATH`, inventory requests use that instance Socket.
`check --cdp` likewise checks only those CDP browsers.

Call `browser_release` only on explicit user requests to end debugging, detach, or clean session resources. It releases
debugger/CDP control and temporary session state while keeping browsers/tabs. Providers declare managed-instance launch, close, persistence,
access, and sign-in synchronization semantics; run `mearl <providerId>`. Access URLs are excluded from
`browser_list`; explicitly run `mearl check --browser <id|name>` when needed and treat returned
`browserAccess.url` as sensitive.

## Architecture

```
@mearl/client (CLI / SDK)
  ├─ Local → @mearl/native-host → Chrome Extension / CDP
  ├─ Local → @mearl/provider runtime → External Provider
  └─ WebSocket → @mearl/cloud-server → @mearl/cloud-connector
                                      ├─ @mearl/native-host → Chrome Extension / CDP
                                      └─ @mearl/provider runtime → External Provider
```

Infrastructure must avoid recursive routing: `@mearl/cloud-connector` directly connects to local native-host through `@mearl/client/local`. Ordinary Agent, CLI, and MCP integrations use the package root.

Plugin code is organized by responsibility in `src/plugins/`:

| Directory | Responsibility |
| --- | --- |
| `sdk/` | Plugin declarations, command interfaces, and page/model/state/recovery validation |
| `clients/` | Service connections and task/model/page/state clients |
| `runtime/` | Service assembly, scheduling, storage, snapshots, executors, and cleanup |
| Plugin directory root | Registration, resource packaging, official plugin installation, and shared client/server protocol |

Tests live in nearby `__tests__/`. Public exports use `@mearl/client` and `@mearl/client/plugin`; root `plugin.ts` is the public entry. Process entries `plugin-worker.ts`, `plugin-task-host.ts`, and `pluginModelSessionWorker.ts` remain in the `src/` root. `runtimePaths.ts` locates package versions and entries consistently for per-file compilation and Native Host bundling. `browser-core` still synchronizes generated protocol into `src/generated/`.

## Build

```bash
pnpm build      # Compile with tsc into dist/ and make cli.js executable
pnpm dev        # tsc --watch
pnpm typecheck  # Type checking only
```

## License

Apache-2.0

### Plugin page instances

`PluginPageClient` manages attach/get/list/send/detach/events/activation through local plugin services. Plugins declare independent `pageRuntime` and use `app.page()`. Hosts syntax-check code expressions with Node's compiler without executing them. Browser evaluation must produce self-contained functions; nonfunctions/external-reference errors appear at page runtime. Extension/pure CDP share instances, events, activation, and document runtimes. documentId binds instances; same-plugin/same-document entries share initialization. Navigation invalidates instances; activation rules rebuild them. `frame` accepts `main`, `business`, or `page_frames` IDs (numeric Extension, string CDP). External Providers must declare `page_runtime`.

Explicit manual `attach` reusing an automatic instance changes ownership to manual while preserving initialization and running tasks. Later narrowing automatic scopes does not remove it.

To change matching scope independently, pass `enabled: true, matchPatch: { add?: string[], remove?: string[] }`, mutually exclusive with `matches`. Hosts atomically add/remove scopes to avoid concurrent overwrites. Removing the final scope disables automatic activation while retaining manually attached instances. `persistence: 'persistent'` survives browser restarts. Initialization handlers can read current plugin preferences instead of copying volatile settings into rule input.

```typescript
const pages = new PluginPageClient();
try {
  const page = await pages.attach('example', { tabId: 123, frame: 'business' });
  await pages.send('example', page.instanceId, { type: 'read' });
} finally { pages.disconnect(); }
```

Background events declare schemas and serial, latest-coalescing, or bounded-concurrency policies. app.runtimeCommand handlers use `context.page` for fixed documents. Document-bound tasks may read their plugin's activation rules with `app.page('activation')` but cannot modify them. Messages/results allow 24 MiB each with automatic chunks/checks; events allow 32 KiB. Toolbox uses `host.page.*`; UI history subscription is independent of execution. See [plugin host capabilities](../../docs/plugin-runtime.en.md#page-runtimes-and-events).

Python exports the same `pageRuntime` dictionary, with `code` as browser-side JavaScript function strings. Register initialization/events through app.runtimeCommand or decorators. `app.page(operation, payload)`, `context.page.send(message)`, and `context.page.get()` are synchronous; the latter two require instance-bound handlers. JS/Python `context.page.send(message, {timeoutSec: 120})` sets per-response timeouts above 0 and at most 300 seconds (Python uses dictionaries). `app.page("send", {instanceId, message, timeoutSec})` and SDK `pages.send(plugin, instanceId, message, {timeoutSec})` also support it. Other requests are unaffected. Cancellation/detach still interrupts immediately; transport failures cancel the page request. Runtime-only commands remain hidden and inaccessible through CLI/toolbox; ordinary `app.command` event handlers remain publicly callable.

### Model tasks and declared state

`PluginModelClient` uses local Codex without browsers. Model/command tasks share querying, cancellation, and lossless results with separate scheduling. Query `capabilities()` first; only explicit read-only Agent mode is supported, and strictly tool-free generation fails.

```typescript
import { PluginModelClient, PluginStateClient } from '@mearl/client';
const models = new PluginModelClient();
try {
  const result = await models.run('example', {
    provider: 'codex', mode: 'agent', permissions: 'read-only', prompt: 'Return a short title.',
    outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
  }, { signal: controller.signal });
  console.log(result.output);
} finally { models.disconnect(); }
```

`start` returns persistent taskId; `run` signals cancel execution and await cleanup. `app.model(request, { onProgress })` / `context.model(request, { onProgress })` subscribe to that call's `model.delta`, isolated across concurrent calls; Python uses `context.model(request, on_progress=callback)`. Incremental `data` contains `delta/index/partial` and optional `itemId/phase`. Isolate messages, skip commentary, and fall back to final results on sequence gaps. Deltas are temporary display only; final results come from successful turns' complete messages. outputSchema passes to Providers; hosts parse JSON; plugins validate structure/business constraints. Retract temporary output on failure; never cache it or infer success. Use `PluginModelClient`/context for catalogs/execution; toolbox uses `host.model.capabilities/list/start` and `waitTask`.

Declare collections in plugin entries, then access them from command contexts:

```javascript
export const stateStorage = { version: 1, collections: {
  settings: { scope: 'installation', storage: 'persistent', schemaVersion: 1, schema: { type: 'object' } },
} };
export default app => app.command('save', async (input, context) => {
  const previous = await context.state('settings', 'get', { key: 'config' });
  return context.state('settings', 'transact', { transaction: { operations: [
    { type: 'put', key: 'config', value: input, expectedVersion: previous.version },
  ] } });
});
```

SDK `PluginStateClient.get/getMany/list/transact` and toolbox `host.state.*` share collections. Writes require CAS; conflicts require reread/merge/retry. `schemaVersion` upgrades use explicit migrations. Browser-session/instance scopes support `cache` or `memory` with host-verified page identities. `memory` resides only in the execution host, sharing CAS/schema/TTL/chunk limits. Browser-session scope survives document refresh and isolates new sessions; host restart clears it. Host-wide memory allows 128 MiB/512 namespaces on demand; `maxBytes` per collection allows 128 MiB. Instance end releases memory. See [plugin host capabilities](../../docs/plugin-runtime.en.md#state-and-activation) for quotas/TTL. Binary assets still use files/resource channels.

### Explicit task recovery

Plugins declare `taskRecovery` with per-command checkpointVersion/schema and register `app.recoveryCommand(command, handler)`. `context.checkpoint(data, expectedSequence)` saves up to 64 KiB. Data, version, host schemaHash, sequence, and events atomically commit with tasks using CAS. Schemas establish identity/format compatibility; plugins validate checkpoint/migration structures.

`tasks.checkpoint(taskId)` reads checkpoints. `tasks.resume(taskId, { environment?, revision? })` creates new attempts for terminal root commands, retaining old terminal tasks and original installation, snapshot, input, directory, and route. Default environment comes freshly from the caller; old environments are not persisted. Recovery handlers read `context.recovery` and check external state first. Hosts neither replay original handlers nor guarantee atomic external submissions/checkpoints.

Use `tasks.checkpoint(taskId)` / `tasks.resume(taskId)`. Only public/service roots qualify; models, children, page bindings, and caller routing reject recovery, and original trees must be confirmed stopped. Original code is the default; explicit `revision: 'current'` pins request-time snapshots. Same-version schemas must match. Cross-version targets declare `taskRecovery` `migrateFrom: [{ version, schema }]` and hidden `app.checkpointMigration(command, handler)`, returning target checkpoint data. Hosts verify historical schemaHash, forbid host/nested-plugin APIs during migration, and manage processes with 10-second deadlines. Conversion must be retryable and side-effect-free; trusted code is not an OS sandbox. Concurrent recovery coalesces into one conversion/successor; original tasks/data remain. See [checkpoints and explicit recovery](../../docs/plugin-runtime.en.md#checkpoints-and-explicit-recovery).

Plugin CLI failures return nonzero and stderr JSON `{ "error": { "code", "message" } }`, preserving SDK/MCP codes without arbitrary exception extras. `PLUGIN_TASK_WAIT_TIMEOUT` stops observation only; `PLUGIN_EXECUTION_CANCELLED` / `PLUGIN_EXECUTION_DEADLINE` indicate cancellation/deadline; `PLUGIN_PAGE_TARGET_CHANGED` / `PLUGIN_PAGE_INVALIDATED` require new instances; `PLUGIN_STATE_CONFLICT` requires fresh CAS reads; `PLUGIN_MODEL_CAPABILITY_UNSUPPORTED` means unsupported capabilities; `PLUGIN_INVOCATION_CYCLE` / `PLUGIN_INVOCATION_DEPTH` reject cycles/depth. Unconfirmed process-tree termination retains failure records and rejects recovery.

Explicit toolbox page attach requests missing site permissions and continues after user confirmation. Background page runtimes never prompt automatically.

Query models through SDK `PluginModelClient.list()` or toolbox `host.model.list`. Entries include supported `reasoningEfforts` and `defaultReasoningEffort` where available; UI restricts choices accordingly. Hosts coalesce discovery, immediately return existing catalogs, and refresh stale data in background. Failures retain usable catalogs with short backoff and create no inference sessions. Batch state reads use `get-many` and `keys` (SDK `getMany`, toolbox `host.state.getMany`) for up to 128 `keys` at one revision, including missing keys' CAS versions, limited to 1 MiB.


`PluginHost` assembles tasks, state, pages, and model catalogs with shutdown/diagnostics. `PluginTaskManager` receives explicit dependencies and owns execution trees; page/state services do not mutate schedulers. `PluginHostConnection` manages RPC, discovery, handshake, reconnection, and bridging. Share connections through Task/Model/State constructor `connection` options or Page's second constructor argument. Creators close injected connections; client `disconnect()` closes only owned connections. Connections bind one caller scope and cannot cross plugins, interaction channels, or sources.

Continuous background model calls may specify `conversation` (1–80 letters, digits, or `:_-`). Same-name reuse is limited to the current page instance or current host-managed command. Plugin, revision, model, instructions, environment, and ownership isolate sessions. Omission creates independent calls. Detach/command end releases conversations; cancel/failure/timeout destroys them. Idle expiry is five minutes; temporary sessions restart every 32 turns to bound history. Conversations are memory-only with no new global CLI/MCP commands.

## Managed plugin catalog

Installation hosts use client/plugin replaceOfficialPluginCatalog(revision, plugins) to save selected-preset catalogs. revision is the exact manifest digest; entries contain description, skill, installer installArgs, and optional setup grouping. Atomic replacement saves .official-catalog.json in the registry directory; catalogs default empty. Hosts own source/preset trust checks; catalogs alone do not install.

findOfficialPlugin/listOfficialPluginNames reread current catalogs and reuse setup for missing plugins. readOfficialPluginCatalog reports corruption to installation status; ordinary plugin/browser commands ignore corrupt optional catalogs without affecting registered capabilities. Compatibility export OFFICIAL_PLUGINS reflects the most recently read catalog in the process.

Extension update checks default to config.json from GitHub's latest stable release. Distribution hosts may set MEARL_EXTENSION_CONFIG_URL to an endpoint returning version or latestVersion. Until extension metadata is uploaded, update data is unavailable; source versions are not published extension versions. Check failures affect notifications only.
