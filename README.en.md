# Mearl

[简体中文](README.md) | [English](README.en.md)

Automate and debug with an agent in the browser you already use. [Product website and quick start](https://mearlhq.github.io/mearl/en.html).

Mearl reuses your browser's sign-in for tasks like checking a feature, diagnosing a web issue, comparing a design, or exporting a report. Verify recurring tasks once, then package them as Skills that use browser actions or call suitable endpoints directly. Work in the extension or use the CLI, TypeScript SDK, and MCP to give tasks to an agent.

## What you can do

- **Automate pages**: Read snapshots, click, type, scroll, upload, download, and take screenshots across tabs and control sessions.
- **Debug requests**: Inspect HTTP requests, responses, and streaming events; replay requests; configure mocks, redirects, and header rules.
- **Inspect pages**: Read console logs, inspect element dimensions, styles, occlusion, and scroll containers, and capture and query analytics events.
- **Simulate environments**: Adjust the viewport, touch input, User-Agent, and time zone; configure App WebView environments through installed profiles.
- **Compose tasks**: Orchestrate browser actions and registered Skill commands in JavaScript with `mearl run`.
- **Connect more browsers**: Control browsers through the local extension, CDP, a cloud Connector, or an independent Provider.

The extension provides a DevTools panel, popup, side panel, and toolbox. The CLI, SDK, and MCP share the browser action catalog. A control session keeps the steps of a task on the intended browser and tabs. [Control sessions](packages/client/README.en.md#control-sessions-and-files)

## Get started

Mearl 3.0 runtime packages require **Node.js ≥ 20.18.0**. Use **Chrome ≥ 120** or a Chromium browser supporting the required extension APIs. See [extension compatibility](packages/extension/README.en.md#browser-compatibility) for individual features.

### Use with an agent

Copy this prompt into your agent.

```text
Run this command to install the Mearl Skill.
npx --yes skills add mearlhq/mearl --skill mearl --global

Read the Skill and follow its instructions to set up my local environment.
Tell me what to do if a step requires my input in Chrome.
Verify the browser connection and report the result.
```

If your client requires MCP, run `npx @mearl/setup --mcp` after setting up the local environment. [MCP documentation](packages/mcp-server/README.en.md)

### Install locally

```bash
npx @mearl/setup
```

The installer sets up the `mearl` CLI, Native Host, and main Mearl Skill. Install the extension version that matches the local runtime.

- Download and extract `mearl-chrome-v*.zip`. Open `chrome://extensions/`, enable **Developer mode**, and choose **Load unpacked** to select the extracted folder. [GitHub Releases](https://github.com/mearlhq/mearl/releases)
- Add Mearl to Chrome when the store offers the matching version. [Chrome Web Store](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm)

Enable **Agent service** in Mearl, then run `mearl check --local` to verify the connection. [Setup documentation](packages/setup/README.en.md)

Run `mearl guide` for the current CLI's core workflow and `mearl guide --list` for additional topics. Use `mearl <action> --help` for arguments. Guides ship locally with the client and do not connect to a browser or trigger updates. The Skill distributes a compact entry point; the CLI provides the guide content. MCP-only clients should follow tool descriptions and schemas directly.

### Run your first browser task

Paste this prompt into an agent with the Mearl Skill or MCP tools.

> Use Mearl to open https://example.com in my browser, tell me the page title, and take a screenshot.

To try the JavaScript runner from a terminal, open a tab and print its snapshot.

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

When multiple browsers are connected, use a returned `browserId` with `--browser <browserId>`. Continue using the returned `tabId` for subsequent actions. Check `mearl <action> --help` for arguments.

### Use in code

Once the local environment and browser connection are ready, use the TypeScript SDK:

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

Installing dependencies sets up a Git pre-commit hook. At commit time, ESLint checks and fixes staged TypeScript files under `packages/**/src/`, and Prettier formats staged TypeScript and JSON files there. Git stops the commit if lint errors remain. Run `pnpm lint` from the repository root to lint manually. Running `pnpm format:check` checks all files in that scope and may report existing formatting differences in files outside the commit.

See [AGENTS.md](AGENTS.md) for commit conventions, code style, and validation by change scope. The [release guide](docs/releases.en.md) covers automatic beta numbering, npm OIDC, and extension artifact distribution.

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
