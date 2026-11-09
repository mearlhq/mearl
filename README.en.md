# Mearl

[简体中文](README.md) | [English](README.en.md)

Automate and debug with an agent in the browser you use every day.

Mearl reuses your browser's existing sign-in so an agent can help you verify features, investigate page issues, and export reports. You can also inspect requests, configure mocks, and emulate device environments directly in its Chrome DevTools panel. Package verified workflows as Skills to reuse in future tasks.

[Product website](https://mearlhq.github.io/mearl/en.html) · [Chrome Web Store](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm) · [GitHub Releases](https://github.com/mearlhq/mearl/releases)

## Get started

### 1. Install the browser extension

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm), or download `mearl-chrome-v*.zip` from [GitHub Releases](https://github.com/mearlhq/mearl/releases), extract it, enable **Developer mode** at `chrome://extensions/`, and choose **Load unpacked**.

Use **Chrome ≥ 120** or a Chromium browser with the required extension APIs. [Browser compatibility](packages/extension/README.en.md#browser-compatibility)

The DevTools panel is ready to use after installation. To let an agent control the browser, continue with the setup below.

### 2. Connect your agent

Local components require **Node.js ≥ 20.18.0**. Choose either agent-assisted or manual setup.

**Let your agent configure Mearl**: copy this prompt into an agent that supports Skills.

```text
Run this command to install the Mearl Skill:
npx --yes skills add mearlhq/mearl --skill mearl --global

Read the Skill and follow its local setup instructions. Check that the extension and local components have matching versions.
Tell me the steps if you need my input in Chrome.
Run mearl check to verify the connection and report the result.
```

**Configure manually**: run the installer in your terminal to install the CLI, Native Host, and Mearl Skill.

```bash
npx @mearl/setup
```

Use the same extension version as the local components. In the Mearl popup, enable **Agent Service** under **Settings → Services**, then run `mearl check` to verify the connection. [Setup documentation](packages/setup/README.en.md)

For MCP clients, run `npx @mearl/setup --mcp` after local setup to configure the integration. [MCP documentation](packages/mcp-server/README.en.md)

### 3. Run your first task

Try this prompt in an agent connected to Mearl.

> Use Mearl to open https://example.com in my browser, tell me the page title, and take a screenshot.

## CLI and SDK

Once connected, you can also open a page from your terminal and print its snapshot:

```bash
mearl browser_list
mearl run <<'JS'
const tab = await mearl.tabOpen({
  url: 'https://example.com',
  reuse: 'prefer',
});
console.log(await mearl.pageSnapshot({ tabId: tab.tabId, mode: 'viewport' }));
JS
```

If multiple browsers are connected, use a `browserId` returned by `mearl browser_list` with `mearl run --browser <browserId>`. Run `mearl guide` for the workflow, `mearl guide --list` for topics, and `mearl <action> --help` for arguments.

To use the TypeScript SDK in your project:

```bash
npm install @mearl/client
```

```typescript
import * as mearl from '@mearl/client';

const tab = await mearl.tabOpen({ url: 'https://example.com' });
const page = await mearl.pageSnapshot({ tabId: tab.tabId });
console.log(page.snapshot);
```

See the [CLI / SDK documentation](packages/client/README.en.md) for actions, control sessions, scripts, and plugins.

## What you can do

- **Automate pages** by reading snapshots, clicking, typing, scrolling, uploading, downloading, and taking screenshots.
- **Debug requests** by inspecting HTTP requests, responses, and streaming events, replaying requests, and configuring mocks, redirects, and header rules.
- **Inspect pages** by reading console logs, checking element dimensions, styles, occlusion, and scroll containers, and capturing and querying analytics events.
- **Emulate environments** by changing the viewport, touch input, User-Agent, and time zone, or using App profiles to emulate a WebView.
- **Compose tasks** with `mearl run` by combining browser actions and Skill commands in JavaScript.
- **Connect browsers** through the local extension, CDP, a cloud Connector, or a Provider.

The extension provides a DevTools panel, popup, side panel, and toolbox. The CLI, SDK, and MCP share browser actions and can use control sessions to keep a task on the intended browser and tabs. [Control sessions](packages/client/README.en.md#control-sessions-and-files)

## Extend Mearl

| Extension | Purpose | Documentation |
| --- | --- | --- |
| Skill | Agent guidance, optionally with CLI commands and toolbox pages | [Skills](skills/README.en.md) · [Create a Skill](skills/mearl-skill-creator/SKILL.md) |
| Provider | Connect browser platforms or devices and declare supported actions and lifecycle | [Provider](packages/provider/README.en.md) · [Create a Provider](skills/mearl-provider-creator/SKILL.md) |
| App emulation | Add a new App WebView environment with a User-Agent, JSBridge, and container behavior. Distributed through a capability package. | [App emulation configuration](packages/app-profiles/README.en.md) |
| Capability package | Supply host implementations and browser resources through a manifest | [Capability model](docs/capability-model.en.md) |
| Preset | Compose capability packages, Skills, and Providers with default configuration and permission requirements | [Preset](packages/preset/README.en.md) · [Installation](docs/preset-installation.en.md) |

The repository includes [installable Skills](skills/README.en.md) for design overlays, bilingual reading, format conversion, notes, tab management, and image compression.

## Develop from source

Source builds require **Node.js ≥ 22.23.4** and **pnpm 10.34.5**.

```bash
pnpm install --frozen-lockfile
pnpm build
```

Load `packages/extension/dist_chrome` as an unpacked extension. Use `pnpm dev:website` to develop the website.

The pre-commit hook checks and formats staged source files. Run `pnpm lint` and `pnpm format:check` to check manually. [Development guidelines](AGENTS.md) · [Release guide](docs/releases.en.md)

| Directory | Responsibility |
| --- | --- |
| `packages/extension` | Browser extension and UI |
| `packages/client` · `packages/mcp-server` | CLI, SDK, and MCP integration |
| `packages/native-host` · `packages/cloud` | Local and remote connections |
| `packages/browser-core` · `packages/app-profiles` | Browser actions, shared protocols, and environment simulation |
| `packages/preset` · `packages/provider` | Capability packages, Presets, and Provider contracts |
| `packages/agent-runtime` · `packages/daemon-core` | Models, tasks, and process runtime |
| `packages/setup` · `packages/website` | Installer, product website, and installation guide |
| `skills` | Independently installable Skills, scripts, and toolbox assets |

## License

[Apache-2.0](LICENSE). Third-party dependencies and resources retain their own license notices.
