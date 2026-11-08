# @mearl/extension

[简体中文](README.md) | [English](README.en.md)

The Mearl Chrome extension provides a web debugging UI and browser control entry points for agents.

Built on Manifest V3 with React 19, TypeScript, and Tailwind CSS (production rendering uses Preact to reduce size). Alongside request inspection, mocks, and request rules, Native Messaging exposes browser capabilities to local and cloud AI agents through MCP and Skills.

## Browser compatibility

- The extension requires Chrome 120 or later.
- On Chrome 120–140, use the shortcut to open the Agent side panel and Chrome's close button to close it. Chrome 141 and later support closing it with the shortcut.
- Device Shell and app profiles with a page runtime require Chrome 125 or later.
- Plugin page scripts require Chrome 135 or later. On Chrome 135–137, enable **Developer mode** on the Extensions page. On Chrome 138 and later, enable **Allow User Scripts** in the Mearl extension details.
- Built-in translation requires Chrome 138 or later.

## Features

- 📊 **Requests** — Inspect HTTP / Protocol requests, responses, and analytics events. In a fixed phone preview, the Mearl Panel opens beside the device in wide windows and collapses in narrow ones. Use the **Debug** icon to toggle it manually. Drag the divider to set the width for future sessions. Screenshots and browser actions target the active WebView.
- 📱 **Device simulation** — The **System bars** switch adds the status bar and bottom controls. On supported fixed devices with a single WebView, the extension also offers a **Phone frame** switch, enabled by default. Its saved preference applies whenever the extension opens an eligible simulation. Agent commands can set the system bars with `deviceShell`.
- 📝 **Logs** — Collect page console logs.
- 🎭 **Mocks** — Configure mock data dynamically and modify responses through the Chrome debugger API.
- 🔀 **Request rules** — Redirect requests and modify headers through Declarative Net Request.
- 🤖 **Agent integration** — Expose screenshots, page actions, snapshots, and other browser capabilities through Native Messaging.
- 💬 **Agent Chat** — Chat about the current tab from the toolbar popup or the Agent side panel. Use the side panel icon in the Chat toolbar to continue in the side panel and select or annotate page elements. Browser Management is in the toolbox by default.
  Select Codex or Qoder from the Agent menu. If a supported Agent is missing, choose **Install** to add its local components. Choose **Sign in to Qoder** to authorize Qoder in your browser. Return to Agent Chat and choose **Resend** for a failed text message.
  Both chat surfaces can display HTML charts referenced by Codex from `~/.mearl/visualizations` or the Codex `visualizations` directory. Mearl chat directs Codex to save inline charts under `~/.mearl/visualizations` so they remain available in chat history while the files exist. The preview automatically loads chart libraries from jsDelivr, cdnjs, esm.sh and unpkg, as well as Codex chart and widget runtimes and Google Fonts or Bunny Fonts. CDN scripts can read the chart content in the preview. The preview blocks API requests such as `fetch()`.
- 🔄 **Update notifications** — Setup-managed versions check remote configuration; Chrome-managed versions notify after an update downloads. Users reload explicitly and can read the corresponding release notes.

## Development

```bash
# Install dependencies from the repository root
pnpm install --frozen-lockfile

# Watch src and rebuild
pnpm --filter @mearl/extension dev

# Build the extension and its workspace dependencies
pnpm --filter @mearl/extension... build
```

Load into the browser:

1. Open `chrome://extensions/` and enable **Developer mode**.
2. Click **Load unpacked** and select `packages/extension/dist_chrome`.
3. Press F12 on a web page and select the **Mearl** panel.
4. To use CLI, SDK, or MCP control, enable Agent service in the extension and install the local environment with [setup](../setup/README.en.md).

## Scripts

```bash
pnpm --filter @mearl/extension build       # Production build
pnpm --filter @mearl/extension typecheck   # Type checking
pnpm --filter @mearl/extension test        # Tests
pnpm --filter @mearl/extension i18n:check  # Translation key checks
```

## Directory structure

- `src/pages/background/` — Service Worker: debugger API, request interception, Agent Bridge, and capability handlers.
- `src/pages/panel/` — DevTools panel (main UI).
- `src/pages/popup`, `sidepanel`, `options`, `devtools`, etc. — Other extension pages.
- `src/pages/content-script/` — Content scripts (early MAIN world injection and ISOLATED world).
- `src/locales/` — i18n messages (`zh_CN` / `en`).

> See the root [AGENTS.md](../../AGENTS.md) for architecture, communication patterns, and coding conventions.

## License

[Apache-2.0](../../LICENSE)
