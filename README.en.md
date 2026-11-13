# Mearl

[简体中文](README.md) | [English](README.en.md)

A browser work environment for AI agents: automate, debug, and verify in the browser of your choice.

Mearl connects page actions, network requests, logs, and environment emulation so agents can complete tasks, investigate issues, and verify results. Connect your everyday browser, a browser through CDP, or a remote environment through a Provider. Package verified workflows as Skills to reuse through an agent, the CLI, or the Toolbox. People can also inspect and debug pages in the extension’s DevTools panel.

[Product website](https://mearlhq.github.io/mearl/en.html) · [Chrome Web Store](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm) · [GitHub Releases](https://github.com/mearlhq/mearl/releases)

## Get started

### 1. Set up the local environment

Requires **Node.js ≥ 20.18.0**. Run setup to install the CLI, Native Host, and Mearl Skill. Select your agent integration when prompted:

```bash
npx @mearl/setup
```

Or give this prompt to an agent that supports Skills:

```text
Run npx @mearl/setup to install Mearl, then read the installed Mearl Skill.
Configure a browser connection for the task. Tell me the steps if you need my input.
Run mearl check and mearl browser_list, and report whether the intended browser is connected.
```

For MCP clients, run `npx @mearl/setup --mcp` to configure the integration. [Setup documentation](packages/setup/README.en.md) · [MCP documentation](packages/mcp-server/README.en.md)

### 2. Choose a browser connection

- **Everyday browser**: optionally install the [Chrome extension](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm) to reuse open tabs and signed-in sessions and access the Toolbox and DevTools.
- **CDP Provider**: use `browser_manage` with `attach` to connect to Chrome or Electron with remote debugging enabled. Use the returned `browserId` to control existing pages.
- **[Firefox Provider](https://github.com/mearlhq/provider-firefox)**: attach to Firefox with a local WebDriver BiDi port. No extension is required. It lives in its own repository and, once published, installs with `npx @mearl/setup provider install @mearl/provider-firefox`.
- **Remote browser or device**: install and configure the corresponding Provider. Available actions depend on its declared capabilities.

See the [CLI / SDK documentation](packages/client/README.en.md) for connections, permissions, and supported capabilities. Setup prepares local tools; complete extension installation and environment connection for your selected route.

### 3. Verify the connection and run your first task

Keep your target environment running and confirm that the intended browser appears in the list:

```bash
mearl check
mearl browser_list
```

Try this prompt in an agent connected to Mearl. Include the target `browserId` when multiple environments are connected:

> Use Mearl to open <https://example.com> in the selected browser, tell me the page title, and take a screenshot.

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
- **Emulate environments** by changing the viewport, touch input, User-Agent, and time zone, or using App Profiles to emulate a WebView.
- **Compose tasks** with `mearl run` by combining browser actions and Skill commands in JavaScript.
- **Connect browsers** through the local extension, CDP, a cloud Connector, or a Provider.

The extension provides a DevTools panel, popup, side panel, and toolbox. The CLI, SDK, and MCP share browser actions and can use control sessions to keep a task on the intended browser and tabs. [Control sessions](packages/client/README.en.md#control-sessions-and-files)

## Extend Mearl

| Extension | Purpose | Documentation |
| --- | --- | --- |
| Skill | Agent guidance, optionally with CLI commands and toolbox pages | [Skills](skills/README.en.md) · [Create a Skill](skills/mearl-skill-creator/SKILL.md) |
| Provider | Connect browser platforms or devices and declare supported actions and lifecycle | [Provider](packages/provider/README.en.md) · [Create a Provider](skills/mearl-provider-creator/SKILL.md) |
| Profile | Emulate an App WebView with its User-Agent, JSBridge, and container behavior | [App Profile](packages/app-profiles/README.en.md) |
| Preset | Install Profiles, integrations, Skills, and Providers together with defaults and permission requirements | [Preset](packages/preset/README.en.md) · [Installation](docs/preset-installation.en.md) |

The repository includes [installable Skills](skills/README.en.md) for design overlays, bilingual reading, format conversion, notes, tab management, and image compression.

## Develop from source

Source builds require **Node.js ≥ 22.23.4** and **pnpm 10.34.5**.

```bash
pnpm install --frozen-lockfile
pnpm build
```

Load `packages/extension/dist_chrome` as an unpacked extension. Use `pnpm dev:website` to develop the website.

Run `pnpm dev:link` to build the checkout and symlink local CLI packages and commands (including `mearl`, `mearl-setup`, Native Host and MCP) into the global directory selected by `npm prefix -g`. This supports macOS/Linux and replaces existing installations without backups; repeated runs preserve correct links. Use `pnpm dev:link --dry-run` to preview or `pnpm dev:link --skip-build` to reuse existing build outputs. Ensure this prefix's `bin` directory is on `PATH` ahead of other Mearl installations.

Rebuild after source changes. This command does not install Skills, register Native Messaging hosts or restart running processes; load or reload the browser extension separately. Run `mearl-native-host --init` to register the local Native Host with browsers.

The pre-commit hook checks and formats staged source files. Run `pnpm lint` and `pnpm format:check` to check manually. [Development guidelines](AGENTS.md) · [Release guide](docs/releases.en.md)

| Directory | Responsibility |
| --- | --- |
| `packages/extension` | Browser extension and UI |
| `packages/client` · `packages/mcp-server` | CLI, SDK, and MCP integration |
| `packages/native-host` · `packages/cloud` | Local and remote connections |
| `packages/browser-core` · `packages/app-profiles` | Browser actions, shared protocols, and environment simulation |
| `packages/preset` · `packages/provider` | Presets, resource manifests, and Provider contracts |
| `packages/agent-runtime` · `packages/daemon-core` | Models, tasks, and process runtime |
| `packages/setup` · `packages/website` | Installer, product website, and installation guide |
| `skills` | Independently installable Skills, scripts, and toolbox assets |

## License

[Apache-2.0](LICENSE). Third-party dependencies and resources retain their own license notices.
