# @mearl/setup

[简体中文](README.md) | [English](README.en.md)

Use `@3` to select the latest stable 3.x installer and install matching runtime and extension versions.

One-time installation, updates, removal, and configuration for Mearl environments. No global setup installation is needed:

Run `node --version` before installation to verify Node.js >= 20.18.0.

```bash
npx @mearl/setup [install] [--local] [--cloud] [--cloud-mode <id>] [--mcp]
npx @mearl/setup update [--local] [--cloud] [--cloud-mode <id>] [--mcp]
npx @mearl/setup uninstall [--local] [--cloud] [--cloud-mode <id>] [--mcp] [--full]
npx @mearl/setup extension [--full] [--force]
npx @mearl/setup extension --extract
npx @mearl/setup plugin [name] <path>
npx @mearl/setup plugin install <skills add arguments...>
npx @mearl/setup plugin uninstall <name>
npx @mearl/setup provider <install|update|uninstall> <package|id>
npx @mearl/setup profile install <source> [--browser <id-or-name>]
npx @mearl/setup preset repair [--replace-skill <name> ...]
```

Browser Providers install and evolve independently. After installation, run `mearl <providerId>` to inspect that version's capabilities,
configuration, and launch arguments.

Install optional cloud protocols through a preset before selecting `--cloud-mode <id>`. See [`@mearl/plugin-qoder`](../plugin-qoder/README.en.md) for Qoder pairing; setup does not include or install it by default.

## Install App emulation

```bash
npx @mearl/setup profile install mearlhq/wechat-profile
```

The source can be a public GitHub `owner/repo`, `owner/repo@ref`, or a full HTTPS bundle manifest URL. GitHub sources load the root `bundle.json` from the resolved commit. The command installs every App emulation configuration declared by that bundle and preserves the active Preset. When multiple local extensions are connected, select a target with `--browser`. Confirm source access in the extension if prompted.

In the extension's quick settings, open the App selector and choose **Add App emulation** to select an official option or enter a source. The App button opens the installer directly when the list is empty.

## Install and register Skill plugins

Install a Skill and register its CLI, SDK, and MCP capabilities with one command:

```bash
npx @mearl/setup plugin install https://github.com/mearlhq/mearl --skill browser-tab-manager --yes
mearl tabs summary
```

Installation arguments pass to a pinned public Skills CLI (currently skills@1.5.0, compatible with the project's minimum Node version) using the global shared directory. Both default symlink and copy modes support registration. Copy mode uses list --global --json to confirm the canonical path for this successful install, without guessing directories or scanning other Skills. Set MEARL_SKILLS_PATH for a custom CLI. Arguments reject the -- separator, which would truncate trailing options.

The installation host's local plugin catalog determines preset-managed capabilities. install/update maintains managed registrations and preserves user registrations. Removing the last dependent environment removes managed plugins and the Mearl Skill; other dependent environments retain them. Configuration preparation, host synchronization, and actual status share the [installation contract](../../docs/preset-installation.en.md).

New registrations created by Native preset batches are setup-managed and retain that ownership through Agent updates. Existing user registrations in the same directory and custom user aliases retain their ownership. Managed removal encountering user aliases sharing a Skill removes only managed registrations and keeps Skill files.

GUI and CLI share the preset installer and override rules. If a saved installation is incomplete, `preset repair` retries accepted local resources without redownloading the preset or implicitly replacing conflicting sources. Explicit repeated `--replace-skill` authorizes replacing those Skills' sources or same-name plugin registrations for this invocation:

```bash
npx @mearl/setup preset repair --replace-skill example-skill --replace-skill another-skill
```

Already installed Skills receive registration repair only; source conflicts reinstall. Unlisted conflicts still block installation, and undeclared tool names or changed installation identities are rejected. Replacement authorization does not persist into later repairs or automatic updates. Missing browser permissions still require extension authorization. Output uses preset JSON: ready exits `0`, pending components `3`, installation failure `1`, and invalid arguments `2`.

Automatic registration defaults to the installation directory name; an entry can declare `name` for a shorter command.
Reinstallation refreshes same-name bindings. JavaScript entries must default-export `register(app)`; Python entries must export a `register(app)` function. See the
[plugin runtime contract](../../docs/plugin-runtime.en.md).

Register a Skill distributed elsewhere or a custom entry directly by path:

```bash
npx @mearl/setup plugin /absolute/path/to/browser-tab-manager
npx @mearl/setup plugin custom ./skills/custom/entry.mjs
```

path accepts a directory or file. Directories default to `scripts/main.mjs` or `scripts/main.py`; relative paths resolve against the calling working directory. Plugin names prefer explicit name, then entry `name` metadata, then the Skill directory name. Normal registration needs only path; explicit name is for overrides or older entries. Python requires `python3 >= 3.9`; `MEARL_PYTHON` selects an interpreter. setup validates loading but does not install Python or run `pip install`.
Registration checks the entry's register function and saves its absolute path. Same-name registration updates the binding.
Both flows check local `@mearl/client` and `@mearl/native-host`. If absent or older than setup,
the existing package manager installs setup's matching versions and revalidates. Newer versions remain untouched.
native-host idempotently initializes Skills mode. If environment completion or initialization fails, the installed Skill remains and registration stops.
JavaScript plugins may export `setup({ runCommand })` to prepare Skill-owned dependencies before registration. Both installation paths await it, and registration stops on failure. Skills implement their own first-use dependency checks; see the [client contract](../client/README.en.md#skill-plugins).

After registration, run `mearl <name> --help` anywhere, use SDK `invokePlugin`, or MCP `plugin_invoke`. Ordinary calls do not update Skill sources; missing plugins in the selected catalog trigger one on-demand installation. Skill-owned dependencies are prepared by their installation hooks and first-use checks.

To remove a plugin:

```bash
npx @mearl/setup plugin uninstall tabs
```

For entries under `~/.agents/skills/<skill>/`, setup first runs
`skills remove <skill> --global --yes`, then clears all registrations for that Skill on success.
If the entry directory was manually deleted, Skills can still identify the removal and clean its tracking records.
Removal failures preserve registrations for retry. Other manually registered paths only unregister from Mearl without deleting source.
Repeated removal of an unregistered name succeeds without changes.

## Manage browser Providers

Providers ship as npm packages without requiring their own CLI or install scripts. setup uses the current npm package manager
for global package lifecycle and reads `package.json#mearl.provider` to register the protocol entry,
browser type name, and form arguments:

```bash
npx @mearl/setup provider install @example/mearl-provider-device
npx @mearl/setup provider update example-device
npx @mearl/setup provider uninstall example-device
```

Install accepts package names, versions, and dist-tags; update/remove accept providerId or full package name. Core @mearl packages always use public npm; other scopes follow caller package-manager settings. Installation uses the package manager launching setup;
updates and removal reuse the Provider's original manager. Records contain only
validated package names, installation directories, and package-local entries. Packages cannot inject launch commands, arguments, working directories, or environment variables.
Registration clears only after successful package removal, allowing retries.

## Behavior

- Mearl-owned npm packages install and update from `https://registry.npmjs.org/`, matching version queries. Third-party packages use current manager registry settings.
- `install` is optional: `npx @mearl/setup` equals `npx @mearl/setup install`.
  An initial option also implies installation, such as `npx @mearl/setup --cloud --yes`.
- `install` defaults to `--local` when no environment is specified.
- `-h` / `--help` shows help; `-v` / `--version` shows setup's version.
- Without environment flags, `update` and `uninstall` detect
  `mearl-native-host`, `mearl-cloud-server`, and `mearl-mcp-server` in the current `PATH` and may process
  multiple installed environments.
- Combine `--local`, `--cloud`, and `--mcp` to process only selected environments.
  `--cloud-mode <id>` also selects cloud and requires an installed mode capability.
- Existing environments keep their original package manager and global prefix; first installation uses the manager launching setup.
- `uninstall` recognizes development symlinks installed through `npm link` or `dev:link` into npm global directories,
  removing packages and command links through the original npm prefix while preserving repository source. Install/update autodetection handles normal global installations only.
- Cloud manages `@mearl/cloud-server` and `@mearl/client` together. WebSocket mode starts the server after first installation
  and restarts after updates only if it was running. Other modes use installed `cloud.server.<id>`; all call `stop` before removal.
- local/cloud share `@mearl/client`. Combined installation processes it once; removing one environment retains it if the other needs it.
- Updating a 2.5.x cloud environment first removes `@mearl/cloud-client` to avoid its `mearl` bin conflicting with the unified client.
- local/cloud share the global mearl Skill, located through the Skills JSON inventory and processed once.
- Install/update reinstalls the global mearl Skill from the public repository through `skills add`, associating detected Agents. Updates must confirm this installation and check the global JSON inventory, not rely only on a third-party updater's exit code.
  Skip with `--skip-skill`.
- Removing one environment retains the global mearl Skill if another depends on it.
- Automatic maintenance of selected presets preserves user registrations. Managed removal keeps shared Skill files when user aliases use the same directory.
- `uninstall --full` also removes every registered CLI plugin and browser Provider.
  Skills-installed plugins remove their Skills; manually registered external plugins only unregister, retaining source. Provider
  registrations clear only after successful npm removal. Individual failures do not block other cleanup, but the final exit is nonzero.
  This does not remove the Chrome extension. `extension --full` still means installing the extension and complete local environment.
- After all environments, plugins, and Providers are successfully removed, `uninstall --full` stops the plugin service,
  confirms no active or uncertain-exit tasks remain, and removes task history, source snapshots, service logs, and page-session files of ended hosts. Partial removal, individual failures, or a restarted service retain shared caches.
  Rerun to finish cache cleanup even after packages and registrations are gone. Custom `MEARL_PLUGIN_DIR` limits cleanup to that registry's execution cache.
  Notes, iteration records, settings, identities, plugin persistent state, Provider-private data, browser profiles, and exported designs remain;
  CDP tab-ID counters also remain so stale requests cannot target new tabs.
- `@mearl/mcp-server` commands handle `--mcp` client configuration and cleanup.
- Default `install` / `update` do not manage the browser extension. The separate `extension` command reads
  matching beta extension metadata from `https://github.com/mearlhq/mearl/releases/download/v<version>/` (stable setup uses `releases/latest/download/`) and downloads `mearl-chrome-v*.zip`, atomically extracting it into
  `~/.mearl/chrome-extension`. First installation uses browser-level CDP `Extensions.loadUnpacked`;
  later updates use `mearl check --local --json` to confirm the running extension comes from the setup-managed directory, replace
  files, and reload through Native Host. The fixed directory and manifest `key` keep the extension ID
  and browser storage stable.
- `extension --full` first installs or updates the extension, then uses the local profile to install
  `@mearl/client`, install and initialize `@mearl/native-host`, and install the global Mearl Skill.
  Both parts are attempted; any failure returns nonzero while retaining installed components. It does not install
  cloud or MCP environments.
- Before downloading, CDP checks the source of an extension with the same ID. Installation proceeds if absent or `UNPACKED`
  from the fixed directory. Chrome Web Store, enterprise-policy, and other local-directory installations remain by default. Only explicit
  `--force` takes over and replaces them.

## Install or update the browser extension

For first use, run `npx @mearl/setup` and load the matching release ZIP. You can also use the Chrome Web Store when it offers the matching version. [Installation steps](../../README.en.md#install-locally)

Use this command to let setup manage the extension.

```bash
npx @mearl/setup extension
```

Add `--full` to also install the local CLI, Native Host, and Skill in the same run.

To load the extension manually, run `npx @mearl/setup extension --extract`. Setup downloads the release ZIP,
unpacks it into a new directory under `~/.mearl/extension-downloads/`, and prints the full path. Open
`chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select that directory.
Keep the directory while Chrome uses the extension. This works with Chrome closed and with remote debugging disabled.

Automatic installation uses CDP for first installation, initial migration of older setup extensions, or unavailable Native Host reload. If
Chrome has not enabled CDP, interactive setup prompts you to open
`chrome://inspect/#remote-debugging`, enable remote debugging, and allow the connection, then waits for installation. Human-facing
instructions should omit `--yes`. Without a TTY, use `npx @mearl/setup extension --yes`: it tries
once and stops immediately if CDP is unavailable. If setup ownership cannot be confirmed and CDP is unavailable, it does not download or modify
the extension directory. Enable CDP and rerun the same command. If Chrome lacks required extension-installation CDP methods,
the command stops and asks for a Chrome upgrade.

Each invocation reads the newest extension version from the download page, without requiring it to match setup, CLI, or Native Host.
CDP source checks and `Extensions.loadUnpacked` reuse one connection to avoid repeated authorization.
A successful installation saves a setup-management marker. `mearl check --local --json` reads the marker from the running extension too;
CDP-free updates require matching paths on both sides. If the user later installs the Store version, that running extension
does not return the marker. setup checks through CDP again and preserves the Store installation
unless `--force` is supplied.

Setup-managed extensions check remote `config.json` for updates without silently updating. A newer version adds
a red dot to the DevTools settings button and **Update now** and **Release notes** entries to quick settings.
Only clicking **Update now** makes Native Host revalidate the remote version, ownership marker, download URL,
optional SHA256, and ZIP manifest, then atomically replace the directory and reload. This path never falls back to CDP; Store,
enterprise-policy, and other-directory installations do not use setup updates. For updates downloaded by Chrome,
the extension passively listens to `runtime.onUpdateAvailable` and shows the same user-triggered reload notification, without
actively calling `runtime.requestUpdateCheck()`.

## Automatic updates following the extension

The extension and Native Host exchange versions on first connection. Each extension background startup checks once. When the extension
moves to a higher `major.minor` release line, the older Host keeps its connection available while invoking
the newest `@mearl/setup` in that `major.minor.x` range to update both `@mearl/native-host` and
`@mearl/client` to the newest versions in that range. On success, Host exits and the extension's existing reconnect mechanism
starts the new version. Success requires both local CLI versions to match and belong to the extension's release line.

Automatic updates never downgrade a newer Host or modify cloud, MCP, or independently installed Mearl Skills.
If the npm version is unpublished, the network unavailable, or updating fails, the old Host keeps running. The next extension background
lifecycle may retry; manual updates use `npx @mearl/setup update --local`.

## Human and Agent use

- Humans running interactively should omit `--yes`; setup prompts for Skill targets or MCP clients when needed.
- Agents, CI, and other non-TTY environments should pass `--yes` or
  `--non-interactive`. First installation selects detected Agent / MCP clients; removal clears
  all detected relevant configuration.
- Non-TTY `install` / `uninstall` without these flags exits before changes and prints the correct command.
- Exit `0` means complete success, `1` incomplete execution, and `2` invalid arguments or interaction mode.

## Examples

```bash
# Default local browser environment installation
npx @mearl/setup

# Equivalent to the previous command
npx @mearl/setup install

# Noninteractive Agent / CI installation
npx @mearl/setup --yes

# Install the cloud Agent environment
npx @mearl/setup --cloud

# Use one machine as both a local browser host and cloud Agent
npx @mearl/setup --local --cloud

# Update all detected Mearl environments in the current PATH
npx @mearl/setup update

# Independently install or update the latest browser extension
npx @mearl/setup extension

# Complete local environment: client, Native Host, Skill, and extension
npx @mearl/setup extension --full

# Remove only the local environment
npx @mearl/setup uninstall --local

# Detect and uninstall without interaction
npx @mearl/setup uninstall --yes

# Uninstall environments and all CLI plugins and Providers
npx @mearl/setup uninstall --full

# Install an optional browser Provider
npx @mearl/setup provider install @example/mearl-provider-device
npx @mearl/setup provider install @example/mearl-provider-cloud
```

Existing npm/npx installation methods and CLIs for Mearl environment packages remain available; setup is the unified convenience entry.

## Preset installation

`mearl-setup preset apply <source-url-or-path>` prepares exact resources, activates local Node selections, and synchronizes browser resources to connected, compatible extensions. `preset update` preserves user overrides, and `preset status` reports local readiness and the status of connected extensions. CLI setup exits `3` when local components still need synchronization or installation. [Local installation contract](../../docs/preset-installation.en.md)

Before replacing packages, install/update saves exact resources and expected selections for the selected Preset, then synchronizes hosts and installs Skills after runtime initialization. `extension --full` prepares the same resources before replacing the extension. Existing local selections take priority; explicit `--preset` updates or repairs resources. Unavailable configuration or resources stop package changes; retries after partial upgrades use saved records. Removal never prepares or installs Presets.

The default directory is the public site's `installation.json`; override with HTTPS `MEARL_INSTALLATION_CONFIG_URL` (loopback HTTP allowed for local validation). It uses the web installation validation contract and reports pending until both local and browser sides confirm.

## Browser presets and distribution entry points

Explicit setup first reuses the local preset. Without one, after runtime initialization and before Skill installation, it adopts the connected browser's trusted preset. Explicit `--preset <source>` wins. Differing browser selections, untrusted sources, or failed state reads require an explicit choice. First connection waits about one minute; closed browsers receive only the base environment and retry guidance. Ordinary connections and background core updates do not install an initial local preset.

Distributions can set local-process `MEARL_SETUP_DEFAULT_PRESET` to a default manifest source. It applies only when neither side has a selection. Plugin, Provider, removal, and other subcommands keep their behavior. Setup performs installation and verifies its status.
