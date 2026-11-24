# Mearl

[简体中文](README.md) | [English](README.en.md)

Browser automation and debugging for AI agents.

Let your agent interact with pages, inspect network requests and console logs, and verify results. Reuse open tabs and signed-in sessions in Chrome.

[Product website](https://mearlhq.github.io/mearl/en.html) · [Chrome Web Store](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm) · [GitHub Releases](https://github.com/mearlhq/mearl/releases)

## What you can do

- **Automate pages.** Read pages, click, fill forms, upload and download files, and take screenshots.
- **Debug and verify web pages.** Inspect network requests, responses, and console logs. Mock responses to verify page behavior.
- **Make authenticated requests.** Use matching browser cookies to call a known HTTP endpoint, or replay a captured request.
- **Emulate mobile devices.** Change the viewport, touch input, user agent, and time zone.
- **Reuse workflows.** Package recurring tasks as Skills with instructions for agents, executable commands, or a Toolbox interface.

## Get started

### 1. Install the Chrome extension and local components

Install the [Mearl extension](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm) in the Chrome profile you want to use. It requires Chrome 120 or later.

Run the installer with Node.js 20.18.0 or later. Follow the prompts to select your agent integration.

```bash
npx @mearl/setup
```

For MCP clients, run `npx @mearl/setup --mcp` and restart the client. [Installation guide](https://mearlhq.github.io/mearl/en/installation.html) · [MCP documentation](packages/mcp-server/README.en.md)

### 2. Verify the connection and run your first task

Keep Chrome running and check that your intended browser appears in the list.

```bash
mearl check
mearl browser_list
```

Try this prompt in an agent connected to Mearl. If multiple browsers are connected, give it the target `browserId`.

> Use Mearl to open <https://example.com>, tell me the page title, and take a screenshot.

### Other browser connections

- **CDP.** Connect to Chrome or Electron with remote debugging enabled.
- **[Firefox Provider](https://github.com/mearlhq/provider-firefox).** Install it with `npx @mearl/setup provider install @mearl/provider-firefox` and connect to Firefox through WebDriver BiDi.
- **[External Providers](packages/provider/README.en.md).** Connect other local or remote browsers and devices. Available actions depend on the Provider.

See the [CLI / SDK documentation](packages/client/README.en.md) for more connection options and permissions.

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
