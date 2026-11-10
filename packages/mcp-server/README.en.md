# Mearl MCP Server

[简体中文](README.md) | [English](README.en.md)

Connect an MCP-capable agent to a Mearl browser so it can interact with pages, inspect requests and logs, and invoke registered Skill plugins.

MCP tools share browser actions, plugin entry points, and control sessions with the CLI and SDK.

## Browser interaction workflow

Call `browser_page_snapshot` on first entering a page to establish structure. Then call `browser_page_click/drag/type/hover/scroll/press/upload` directly. Observation is built in by default, combining actions and asynchronous synchronization in one call. Read same-page results from `effects.notifications`, `effects.interactives`, and `effects.focus`. New or changed interactive nodes include actionable `node.ref` values where possible, otherwise `node.selector`. For navigation, read the new URL and readiness; directly opened tabs return reusable `tabId` values in `openedTabs`, without `browser_tab_list`. Usually take another snapshot or screenshot only after navigation, `fullSnapshotRecommended: true`, or when visual judgment is needed. After scrolling, request a viewport snapshot if the next step needs new content. `browser_page_eval` executes without observation by default; explicitly pass `observe` when an expression changes the page and change signals are needed.

Open, navigate, and snapshot responses include a `webmcp` array when discovery finds tools registered by the main document. Pass the tool's `ref` and arguments matching its input schema to `browser_page_call_tool` (`page_call_tool` in the CLI, `pageCallTool` in the SDK). Default discovery runs in the background and omits the field when no tools are found. Use `browser_page_snapshot({ tabId, includeWebMcp: "full" })` to request the catalog explicitly. An empty catalog returns `webmcp: []`. Both the extension and direct CDP support discovery. Callable refs require a browser that can target the original registration. Older browsers report `webmcpStatus: "discovery-only"`. Refresh the catalog after navigation or when a reference expires.

For long lists, prefer `browser_page_snapshot(mode: "viewport")`. Scope known CSS regions with `rootSelector`, existing refs with `rootRef`, and text or role searches with `query`. Use `mode: "interactive"` for viewport controls only, avoiding a full AX Tree. If AX data is empty or sparse, explicitly use `mode: "dom"` for rendered text, native controls, explicit roles, and high-confidence clickable nodes, then act through returned `@ref` values. DOM mode does not infer arbitrary containers' business meaning. Without AX control semantics in the viewport, `interactive` falls back only to AX viewport with `fallbackMode: "viewport"`, never changing data sources automatically. Use `scope` to disambiguate repeated text and `containerPolicy: "nearest"` to scroll a child's container.

Use `browser_page_inspect` for counts, bounding boxes, computed styles, and center-point occlusion. Use `selector: "$0"` for the selected DevTools element. `filter: "horizontal-overflow"` lists nodes with `scrollWidth > clientWidth`, overflow pixels, and nearest scroll containers. For text queries, first obtain structured `matches` and refs with snapshot `query`, then inspect the refs.

Set `observe: false` for bare page actions. Do not routinely append wait, snapshot, or screenshot calls after every action.

Browser tools return the same structures as the CLI and SDK. Snapshot `@eN` refs are directly actionable; internal node mappings remain in the runtime.
Ordinary response `session` includes session ID, browser, transport, state, and generation. Query tabs with `browser_tab_list`;
`browser_control` handoff for ordinary sessions also includes session `tabs`. External Providers use `browser` without `session` and return `{ controlSessionMode: "external", operation, control }`, supporting the advertised `handoff`, `resume` or `finish` operations, with optional `keepTabIds` for finish. `browser_run_actions` steps retain each action's return structure.
With nonempty `fields`, `browser_get_requests` returns extracted fields and request metadata by default. To also include bodies, pass
`includeBody:true`. Otherwise `postData` / `responseBody` are omitted.

`browser_page_click.clickMode` defaults to `auto`: visible desktop pages use trusted mouse input and simulated mobile pages use trusted touch. Hidden pages use a DOM fallback without switching tabs or restoring windows, returning `dispatchMode: "dom"` and `fallbackReason: "page-hidden"`. Override with `dom` / `mouse` / `touch`. Explicit `touch` requires a visible target or returns a precondition error. Trusted input returns the actual `pointerType`.

## Code composition

`browser_run_code` accepts `{ code, browser?, session?, timeoutSec? }` and runs in an independent
Node.js process on the MCP Server host, with the same injected SDK as CLI `mearl run`:

```javascript
const tab = await mearl.tabOpen({ url: 'https://example.com', reuse: 'prefer' });
const result = await mearl.invokePlugin('notes', {
  command: 'search',
  input: { query: 'project' },
});
console.log(result);
```

`console.log(await mearl.help('pageClick'))` returns help shared with CLI `page_click --help`;
`help()` lists methods and registered plugins; `help({ plugin, command? })` queries plugin help.
`console.log(mearl.structure(result))` shows bounded field/type samples from an existing result. See the client's Agent scripting documentation.

APIs and Skill commands inherit browser and session options. With `session: "new"`, first await a browser call establishing the session,
then call the plugin. JavaScript variables reset on each invocation; continue browser tasks with the returned `session.sessionId` and `tabId`.
Browser actions retain their return structures and failure semantics. When model decisions are needed, print necessary observations and end the invocation.

Results include `success`, `stdout`, `stderr`, optional `session` / `error`, plus `executionStopped`,
`mayHaveLateEffects`, and `pendingActions`. Print only data needed by the model and await all SDK calls.
Failures set MCP `isError`. Default execution time is 60 seconds, combined stdout/stderr is limited to 256 KiB, and source to 1 MiB.
MCP cancellation stops the script. Timeouts and cancellation cannot undo dispatched operations; inspect actual state before retrying.
Scripts have the MCP Server host's Node.js permissions and inherit its working directory and environment. Load modules with `await import()`;
execute DOM code through `mearl.pageEval`. Files and registered Skills are read from that host.

## Installation

**Option 1: npx (recommended, stays current)**

```bash
# Run the configuration wizard to generate npx configuration
npx @mearl/mcp-server --configure
```

**Option 2: Global installation (faster startup)**

```bash
# Install globally
npm install -g @mearl/mcp-server

# Run the configuration wizard
mearl-mcp-configure
```

The wizard configures **VSCode Copilot**, **Claude Code**, and **Cursor**. Restart the MCP client afterward.

## Usage

Open a page to debug and ask your AI client:

```
List the current tabs
Take a screenshot of the current page
Get the latest HTTP requests for the specified tab using source all
```

Invoke Skill plugins registered through `@mearl/setup plugin` with the fixed `plugin_invoke` tool:

```json
{
  "plugin": "site-tools",
  "command": "list",
  "input": { "pageIndex": 2 },
  "browser": "<optional Browser ID>",
  "timeoutSec": 30
}
```

`plugin` is a name registered on the MCP Server machine. Plugins declared in the current capability catalog can be installed and registered on demand. Native plugin code, identities, and files execute or are read on that host. Browser operations use the selected browser or an explicitly supplied `browser`.

## Local development

```bash
pnpm install
pnpm --filter @mearl/mcp-server build
```

Run the configuration wizard with a custom Extension ID:

```bash
node packages/mcp-server/dist/configure-bin.js --extension-id <your-development-extension-id>
```

> 💡 Find the Extension ID at `chrome://extensions/`.

Release versions are maintained together with the root repository and other Mearl packages; `server.json` must match. See the [release guide](../../docs/releases.en.md).

## Uninstall

```bash
# Globally installed version
mearl-mcp-uninstall

# Or use npx
npx @mearl/mcp-server --uninstall
```

## Troubleshooting

**Configuration fails**: Check directory permissions and path existence.

```bash
# macOS
mkdir -p ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts
```

**"Native host has exited"**: Remove the configuration and rerun.

```bash
rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/ai.mearl.mcp.*
```

**Extension ID mismatch**: Reconfigure with `mearl-mcp-configure`.

**Logs:**

- MCP Server: The AI client's output panel.
- Chrome Extension: `chrome://extensions/` → Mearl → background page

## License

[Apache-2.0](../../LICENSE)
