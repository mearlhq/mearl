# Local preset installation host

[简体中文](preset-installation.md) | [English](preset-installation.en.md)

`@mearl/setup` manages local preset resources, Node activation, browser synchronization to compatible extensions, and declared Skill/Provider installation and verification. Welcome pages support browser-only installation; with compatible local services, the same web entry installs the complete capability set and retries according to actual state. Complete production distribution still awaits acceptance. Unconfirmed components report pending, without claiming all capabilities are available.

```bash
npx @mearl/setup preset apply https://example.com/presets/team.json
npx @mearl/setup preset apply ./preset.json
npx @mearl/setup preset apply
npx @mearl/setup preset apply --replace-skill example-skill
npx @mearl/setup preset update
npx @mearl/setup preset status
npx @mearl/setup preset uninstall
```

Output is JSON. Exit `0` means all required components are confirmed, `3` means saved desired state has pending installation/synchronization, `1` means failure, and `2` invalid arguments. Status checks neither download resources, execute factories, nor start/install Native Host. Open hosts communicate through existing local Sockets, without cloud access or discovery of other devices.

With a source, `preset apply` installs or switches a preset from a URL or local file. With no source, `preset apply` retries from the saved snapshot. `preset update` rereads the current source and preserves user overrides. Repeat `--replace-skill <name>` when retrying to authorize replacement of those Skill sources or conflicting registrations for that invocation. Each name must be unique and declared as an enabled Skill in the selected preset.

`preset uninstall` removes the local preset selection, matching selections in connected extensions, and setup-managed registrations in the selected preset's plugin catalog. It preserves independent capability packages, Skill files, Providers, browser permissions, and code still in use by open documents. Extensions need a Native Host connection for removal. To remove a browser preset by itself, set `MEARL_SOCKET_PATH` to the target browser's local socket. If the local preset has been removed but a browser still reports `pending`, reconnect the browser and use the same targeting method to retry.

## Exact records and switching

The default directory is `~/.mearl/capabilities`; `MEARL_CAPABILITY_DIR` overrides it consistently with Native Host. SHA-256-addressed package bytes live in `blobs/<sha>.bin`; selected Node entries are hard-linked into `objects/<sha>.cjs`. Immutable `installations/<revision>.json` records exact inheritance graphs, manifests, browser projection revisions, Node revisions, managed module ownership, and user overrides.

Resources, graphs, versions, digests, Node hooks, and quotas are validated before writes. `active-node.json` extends the original Node snapshot with `installationRevision`; one atomic rename selects modules and installation together. Original Node snapshots and their revisions exclude installation metadata and remain independently verifiable. Node selections without installation records remain readable.

Commit uses compare-and-swap against the current selection. Concurrent switching during preparation rejects stale commits rather than overwriting newer choices. Independent user Node modules/hooks remain; conflicts reject before writes. Independent plugin/Provider registrations are not cleaned here. Missing or corrupt managed bytes can be repaired from exact sources; corrupt pointers or installation records reject explicitly. Same-version reinstalls do not overwrite the previous rollback record. Preparation and precommit support cancellation; postcommit synchronization continues from actual results.

Limits: 256 KiB Node selection metadata, 256 KiB user overrides, 16 MiB complete installation records, and the shared 64 MiB package-resource budget. Reclamation retains resources for current and previous rollback selections; explicit cleanup reclaims unreferenced blobs, code, and records. Running functions/documents have already captured old code and do not depend on reclaimed files.

## Defaults and explicit overrides

Package and inheritance sources are manifest URLs. Skill/Provider `source` retains installer semantics: repository shorthand, SSH Git, Git URLs with `#ref`, or npm identifiers. Explicit `./`, `../`, absolute-path URLs, and HTTP(S)/file URLs resolve against their declaring preset, preserving Git refs. `version` constrains installed compatibility and never converts into Git branches/tags.

`PresetInstaller.configure(overrides)` replaces the separate user override object; `{}` restores preset defaults. Effective settings apply `preset.defaults → overrides` above core host defaults. Objects merge recursively; arrays, scalars, and null replace. Updates preserve explicit user intent even if values equal previous defaults, without inferring ownership from equality.

Capability defaults live in `defaults.capabilities`, deeply inherited by module ID. Browser and Node factories read one installation snapshot, for example `"defaults": { "capabilities": { "company-skills": { "manager": "custom" } } }`. Packages define configuration meaning.

Skill management uses one preset-selected `skills.manager` Node hook or standard `skills` by default. One manager handles all sources and existing lockfiles; hosts own disabled state and plugin registration. A same-package `skills.catalog` browser hook can supply browsing using the same defaults. Requests may assert `expectedManagerId`, checked against the captured manager before any CLI/file mutation. Configuration changes reject stale catalog operations instead of reinterpreting and retrying sources. Callers may omit this assertion.

Optional manager `installBatch` accepts multiple Skills from one source and uses normal Agent autodetection when Agent is omitted. Host `capture()` pins the manager for later operations. `installGlobals(source, names)` installs the same-source list once, preserves disabled states, registers plugins individually, and removes stale aliases in that directory. Backends without batching explicitly require a preset update rather than receiving empty Agent values at old required-Agent entries. Existing single-install UI contracts remain.

After package activation, one local host installs external components for `preset apply/update`. It may start local services even when Chrome is closed. It validates exact installation and accepted Node revisions, pins the manager, and processes dependencies in order. Only consecutive independent same-source Skills batch, up to 256 each. Matching installed sources/compatible versions skip the CLI; missing plugin registrations are repaired alone. Unknown sources, same-name different sources, and manifest conflicts reject before batch side effects, preserving user files.

Actual readiness checks include existing Skills lockfiles, enabled/disabled manifest identity and version, plugin/toolbox registration, and Providers' real package.json, entry files, and registration. Explicit Git refs must match; nonempty lock refs are not guessed to mean the default branch. Provider source semver targets and `version` ranges both apply; dist-tags require an offline-verifiable `version` range. Ranges never become Git branches. Checks/status do not run updaters or access source networks.

Preset batches for one user share a global installation lease across capability directories. Hosts track installation processes started through their command services. Timeouts terminate and await process trees; recorded processes surviving host interruption block new batch writes. Failures preserve completed external side effects; retries recheck actual state. An executing installation may finish, but selection changes stop later components. This lease governs preset batches, not all manual changes as one global atomic transaction.

The installation page offers **Overwrite and repair…** for Skill source conflicts and incomplete plugin registration, listing affected Skills and the current configuration URL. Confirmation passes `replaceSkills` only for that retry. The extension verifies current pending membership; Native allows it only in same-revision `resume`. Installer and captured manager constrain scope: source conflicts reinstall while preserving disabled state; installed Skills missing only registration receive registration repair. Listed Skills may replace same-name tool bindings to other directories; other user aliases remain. Declared alias conflicts are checked before installing any component. A missing Skill's conflicting same-name registration reports `SKILL_PLUGIN_REGISTRATION_CONFLICT` early. Unverified sources, manifest identity, Provider conflicts, or changed selections still block. Status refreshes, ordinary retries, and automatic updates carry no replacement authorization, and records never persist it.

Capability configuration has one override entry: `apply(source, { overrides: { capabilities: { packageId: config } } })` or `configure(overrides)`. Execution merges package `defaults`, `preset.defaults.capabilities`, and user `overrides.capabilities`, without separate `nodeConfig`. Defaults never become user overrides. Disable/re-enable preserves choices; `configure({})` clears them all. Unchanged code, effective configuration, and hooks update installation identity without rerunning factories. Browser and Node share this chain and confirm activation separately. See the [capability model](capability-model.en.md).

The extension consumes `defaults.simulation.app` and `deviceSelection`, merges same-installation `overrides`, and fills unsaved App/device quick settings. Existing global/tab preferences win. Defaults are not saved as user preferences, and updates do not switch active documents. Devices retain preset, orientation, fit-window, and shell fields; split-screen is explicitly enabled in documents. Known invalid values reject before activation; unimplemented settings keep `settingsReady` false. Other unsupported settings are confirmed only when actually consumed.

## Activation acknowledgment and failures

The installer requests structured reload from each registered local host and verifies Node/installation revisions. Disconnections or unsupported receipts retain the installation as pending synchronization. Explicit factory rejection CAS-restores the previous selection and notifies all hosts; in-flight functions retain accepted code. Synchronization failure for the same installation reports rejection without historical rollback.

A cold host loading a bad candidate can restore a validated previous selection from a matching rollback record while reporting the candidate error. If another host already rolled back and removed the record, it boundedly loads the current exact selection. Removing the final Node package still requires acknowledgment; an empty component list does not imply readiness.

When installation requires extension confirmation, unconfirmed browser packages report `BROWSER_SYNC_REQUIRED`, and confirmed resources with unapplied settings report `SETTINGS_APPLY_REQUIRED`. Missing Skills/Providers report installation, version, or registration causes. Unavailable component hosts report `INSTALL_REQUIRED` with diagnostics. Unsupported Node execution hosts report `NODE_HOST_NOT_SUPPORTED`. Browsers, local processes, npm, and Skills installation do not form a global atomic transaction.

## Browsers receive the same resources

After Node activation succeeds, setup requests browser synchronization over local IPC from each host. Extensions pull the accepted browser projection through Native Messaging RPC. Node-only packages are excluded; dual-target packages retain all resources to verify bundle revisions. Synchronization uses accepted bytes without redownloading or executing Node factories.

A host keeps one transfer session, expiring after 120 idle seconds. Headers are limited to 16 MiB and browser resources to 64 MiB. Digest-addressed resources transfer in 128 KiB raw chunks, keeping base64 responses below Native Messaging's one MiB limit. Receivers preflight declared quotas before allocating, verify bytes, the complete browser graph, and package revisions, then extensions verify App definitions/page-code references. Before commit, local installation identity is rechecked. Corruption, cancellation, or expiry preserves the previous browser selection.

Browser packages, exact graphs, installation identity, user overrides, and a separate CAS token commit in one IndexedDB transaction. CAS protects graph, package revisions, and installation token, preventing unchanged browser projections with configuration/Node-only changes from overwriting newer selections. Corrupt associations may retain tokens for repair from exact resources. Automatic synchronization refuses takeover of independent same-ID packages. Packages leaving preset management are removed; independent packages and old page code pinned by active documents remain. Unrelated independent-package errors retain diagnostics without blocking graph confirmation.

Browser rejection retains the local desired selection for retry, while each browser retains its working snapshot. Other accepted hosts are not rolled back under an assumed global transaction, and overall readiness stays false. Restarts recheck actual state. Initial Node-only installation preserves independent browser presets; removing the final browser package requires acknowledgment of an empty projection. Saved exact resources/page code restore without Native Host, and independent browser-source installation remains available.


Skill management retains installation, update checks, updates, and removal. Hosts default to standard Skills CLI; installed `skills.manager` capabilities may supply another backend selected by package configuration. All sources use that tool. Hosts maintain catalogs, disabled state, and plugin/toolbox registrations. Switching affects future operations; accepted ones retain implementations. Existing third-party lockfiles are not rewritten. Unsupported source types in the default manager require the appropriate preset rather than interpreting other platforms' shorthand as GitHub.

Browser-callable implementation revisions include code and configuration, so configuration-only updates invalidate old provider identities. Open document instances retain complete accepted configuration; view resources still use bundle revisions for code ownership. Configuration changes do not require another extension release.

## One setup command and web onboarding

Select a preset with the normal first-install command:

```bash
npx @mearl/setup --preset https://example.com/presets/team.json
```

Setup prepares environment packages and the local host, then invokes the same `preset apply` before any Skill operation. The base Mearl Skill uses the selected manager. If preset-managed, its actual state is checked and declared source/ref preserved. Environment-package failures prevent applying presets; preset preparation failures never fall back to public tools. Completion rechecks actual status and exact identity, without overwriting intervening changes with earlier readiness.

Deployment `installation.json` may declare `presets` alongside `guide`. Entries contain only display names, HTTPS manifest URLs, and required Chrome site scopes. Scopes allow explicit HTTP, HTTPS, `*` schemes, and subdomain wildcards, but no all-site grants. Manifest origins count toward the 64-scope limit. Catalogs are limited to 32 presets and 64 KiB, without scripts, CLI arguments, or commands.

Public `bridge.html` is a direct child frame of the configured guide. `connect.html` is a same-site standalone connection page. For manual installation, guides can select registered preset IDs and themes, and the public frame provides the installation button. The extension verifies the actual frame, active document, and guide path, and reads the catalog itself from the fixed public address.

The configured guide can use the installation bridge to start an initial installation for the selected preset. The extension opens the installation page only when both the browser and the connected local host have no selected preset. The guide offers manual updates and switching for existing installations.

The extension opens its own installation page. Existing permissions permit direct preparation; otherwise a foreground button requests Chrome site permissions and records previous Agent domain grants. Chrome retains catalog scheme scopes; Agent uses host domain contracts. Downloads also check HTTPS, catalog scheme/host scope, and current Chrome permissions; they reuse host Cookie injection, reject redirects, and share a 120-second deadline. Resources, graph, digests, Apps, UI, and runtime configuration validate before replacement; catalog and grants are rechecked before commit.

Installation sessions persist in browser session storage for 15 minutes, up to 16 entries, accessible only to their assigned top-level extension installation page. Acceptance pins graph, package revisions, and installation token; preparation-time changes reject overwrites. Refresh after completion only checks status, so old pages cannot reinstall after later selections. A new guide click accepts a new selection. Page recovery rebinds guide communication without duplicating options.

Before replacing packages, setup retains the local preset. `PresetInstaller.stage` downloads, validates, and saves exact resources/desired selection without host calls. Its returned `activate` runs only once after new runtime initialization, using existing synchronization/rollback contracts. Later retries use `resume(revision)` without historical rollback. Saved records identify recovery after partial upgrades independently of package versions and allow recovery after sources close. Explicit sources may repair corrupt resources; concurrent selection changes reject stale operations. `extension --full` prepares resources before extension replacement. Uninstall never prepares/installs presets.

Browser-only installation/persistence needs no Native Host. UI reports browser readiness separately and offers the complete setup command for local components, never inferring readiness from declaration counts. Updating the same browser projection of a Native-associated installation preserves association and overrides. Changed projections or corrupt associations retain records and request setup synchronization rather than clearing overrides and enabling defaults. Compatible local services use the complete web flow below.

## Explicit setup adopts browser selections

During first local installation or manual update, explicit `--preset` wins, then existing local selection. With no local preset, after runtime initialization and before any Skill install, setup queries extensions that are already connected. It proceeds immediately when none are connected.

If connected browsers share one ID/source, setup verifies full ID/URL against the deployment catalog, limits resources/inheritance to its HTTPS scopes, and forbids expanded domain declarations. After preparation, it rechecks catalog and browser selections; commit requires the local state still be unselected. Changes/conflicts reject overwrites. Unreadable browser state, untrusted sources, or differing selections fail explicitly with `--preset <source>` guidance. Setup reports missing Chrome or Agent grants in the extension status.

Local `MEARL_SETUP_DEFAULT_PRESET` supplies a default source when setup finds no explicit, local, or trusted browser selection. Setup activates local preset components and synchronizes the browser projection only to connected extensions. CLI readiness and exit codes track local components. Connected extension results appear in `browsers` and sync rejections also appear in `warnings`. Complete web installation requires extension confirmation. Ordinary Native Host connections and unattended updates never adopt an initial browser preset.

## Complete web installation with local services

At acceptance, the extension uses a combined 1.5-second handshake/read-only check to confirm local protocol and selection. Missing, outdated, or temporarily unavailable services retain browser-only installation and setup guidance. Known corrupt records fail explicitly. Web pages provide no local commands: only extension background may invoke complete-install RPC; Sockets and ordinary extension-page routes reject it.

The local installer uses the same coordinator, reading resources through the extension session with browser sign-in and permissions. Each source is read once per install; resources transfer in 128 KiB chunks with length/digest verification. Single resources are limited to 16 MiB and reserved request budgets total 80 MiB. After Node accepts the exact graph, the browser synchronizes from those same bytes, avoiding divergent source reads.

After preparation and before commit, recheck catalog, permissions, and both sides' accepted selections. After browser synchronization, capture only snapshots associated with this installation revision; stale sessions cannot claim another installation. Initial Node-only installs retain independent browser selections; even core-only browser defaults require browser acknowledgment.

If browser synchronization fails after Node commit, the same page retains exact identity for recovery using validated local bytes without source downloads. Partial external-component failures display pending work with explicit retry, skipping actually ready entries. Postcompletion refresh is read-only. Browser/local status is confirmed separately and complete success requires all confirmations. Temporary local disconnects preserve known capability scope and setup guidance. Other-page installation changes reject stale recovery.

## Installation CLI and manager consistency

`setup plugin install/uninstall`, existing-environment Mearl Skill installation/update/removal, and initial `setup --preset` share installed `skills.manager` selection. CLI captures it in-process, preserving arguments, terminal stdin, output, and exit codes without forwarding interaction over Native RPC. Caller timeouts remain; manual plugin installation has no extra two-minute cap. Agent/preset batches keep bounded execution.

Local capability stores can load modules for explicit hook sets while still verifying complete Node identity, target bytes, and commit guards. CLI loads only the `skills.manager` module, without starting other browser/Provider factories or claiming full activation acknowledgment. Corrupt/outdated managers missing CLI entries require retrying with `preset apply`. Each operation retains captured implementation; subsequent operations read new selections.

Ordinary environment installation cannot overwrite preset-managed base Mearl Skills with defaults. CLI and Agent share source/ref, manifest, version, disabled-conflict, and plugin-registration checks. Declarations or missing files do not imply readiness; ordinary setup/update prompts users to retry with `preset apply` and reports incomplete. Unmanaged base Skills retain public-source installation and verification.

When an installed Skill comes from the same repository and its receipt omits the ref, the installer reinstalls and verifies it at the ref declared by the preset. This migration preserves the Skill's enabled state and requires its directory to be free of user-managed plugin registrations.

Native batches create setup-managed registrations for existing update/removal workflows. Same-name same-directory user registrations retain ownership. Repairing other user alias conflicts reports errors. Agent refreshes or exported-name changes preserve managed ownership and same-directory user aliases. Managed removal retains Skill files shared by user aliases.

## On-demand plugin catalog

`plugins.catalog` Node hooks return existing command aliases and `{ description, skill, setup? }`. Hosts accept only declared enabled Skills and derive installation arguments from inherited declarations, so source overrides need no duplicate catalog. Catalogs publish after component verification, pinned to exact `active-node.json` and installation revision; changed selections invalidate reads. Read-only status checks neither publish nor reinstall catalogs. All aliases participate in readiness.

On-demand installation reuses `setup plugin ensure`, the current manager, and registration flow, sharing the user installation lease with preset batches. Source conflicts reject before install. Existing tool lock records verify source/ref, identity, and declared version afterward; unique paths and aliases are confirmed before registration. Catalog/selection changes retain completed files but reject stale registration and subsequent command execution. Failed/timed-out commands can retry after exit. Catalog invalidation does not delete registered plugins or user-managed entries.

## Declared domains and UI content

`permissions.origins` declares explicit HTTP/HTTPS host scopes, unioned across inheritance, up to 64 without all-site wildcards. Declarations grant no access. Missing Chrome/Agent permissions after CLI sync keep installation pending and prompt **Authorize preset domains** in extension settings; one click requests Chrome grants and registers Agent domains. Web installation retains its authorization flow. Revocation returns status to pending.

`defaults.extension.messages` supplies `{ en, zh_CN? }` by existing message key with inherited overrides and existing substitution rules. `defaults.extension.rulePresets` maps IDs to `{ name, description: { en, zh_CN? }, rules }`, where `rules` uses existing editor forms. Templates only populate editors; save, apply, and authorization use normal flows. Switching/uninstalling presets refreshes dictionaries/templates while retaining saved user rules.

## Trusted preset automatic updates

Extensions check installed presets at startup, then every 12 hours after success or one hour after download/sync/permission failure. Chrome alarms plus persisted check times prevent duplicate downloads on Service Worker restarts. Offline state and resource/inheritance/version/API/contribution failures retain accepted snapshots. Catalog queries and page actions do not wait for updates. Without an installed preset, no recommended entry is selected or installed automatically.

The fixed installation site's `installation.json` defines trust and must match both installed Preset ID and complete source URL. Inherited manifests, package manifests, and resources must stay within catalog HTTPS scopes. Automatic flows reject new local sources, redirects, and URL credentials. Removing/changing catalog sources stops automatic updates; explicit CLI apply/update uses caller-selected sources.

Missing new Chrome/Agent permissions stop updates before commit or native execution, preserve existing capabilities, and open a background authorization page only once. Permission requests require user clicks; authorization resumes updates. Automatic updates do not grant access or upgrade browser-only installations into complete local installations merely because Native Host connects.

When extensions are connected, the browser coordinator updates browser and associated Node selections through existing controlled downloads. Complete updates preflight browser contributions and permissions from the same batch before writing Node pointers. Independent browser and Node-only presets may coexist; Node-only updates remain separate.

Native/CDP hosts check 30 seconds after startup, wake hourly, and honor the same 12-hour/one-hour cadence without keeping processes alive. Cross-process state prevents duplicate checks; hosts yield when browsers coordinate the same selection. Without extensions, expanded browser grants or new browser targets defer until an extension connects or explicit preset update completes.

Automatic updates reuse exact records, source validation, overrides, and conflict checks. Identical content does not reactivate factories. User overrides and independent components remain. Active pages retain accepted definitions/code; later navigation/refresh follows existing App refresh policy, while explicitly locked definitions remain pinned. Temporary cross-side failures retain records and report pending for later retry, never complete success from partial readiness.


## Deployment trust catalogs

Deployers maintain trusted preset catalogs; the core defaults to empty. Website builds inject JSON through `MEARL_INSTALLATION_CONFIG_FILE`; deployment Actions read the same configuration from `MEARL_INSTALLATION_CONFIG`. Third-party discovery catalogs cannot directly become automatic-install catalogs. Presets cannot declare themselves trusted; trusted installation/updates accept matching ID and complete source only.

The default installation site, extension ID, and local default catalog URL share `@mearl/preset/installation-site.json`. setup and Native updates support local `MEARL_INSTALLATION_CONFIG_URL`, which web pages cannot override and which does not change browser trust roots. Automatic updates require HTTPS; explicit CLI migration permits loopback HTTP for local validation. Deployed `installation.json` is readable: include only public addresses and policy, never credentials.


## Direct installation from a website

Websites query extension versions through injected content scripts, then request status/open for known preset IDs. Version probes return only version data, without Native Host, catalog reads, or installation. Buttons open the extension-owned installation view and normal authorization/install flow.

Independent deployments may build extensions with `MEARL_INSTALLATION_CONFIG_URL` pointing to a trusted HTTPS catalog. Builds prepare content scripts and host permissions for its site. Catalog `guide.url` specifies the exact initiating website path. Hosts validate their own content scripts, top frames, current document identities, and catalog source. Pages, URL hashes, and message arguments cannot change trust configuration.

Injected HTTPS pages can also propose a same-origin `catalogUrl` for one installation. Candidates reject credentials, queries, and fragments. Pages can only query status/open a view, never confirm sources, submit commands, or grant permissions. Status returns only confirmation-required flags, without reading catalogs or connecting local services.

After a user click, the extension-owned view shows the actual requesting page and catalog URL. Only **Continue, read configuration** checks Chrome permissions and reads the catalog. `guide.url` must match the requesting page, whose document must remain valid. The selected capability name, full source, and site scopes display afterward. Even existing grants require another **Confirm and install this configuration** click. The coordinator rechecks the same catalog snapshot, selection identity, and permissions before commit.

Source confirmation and authorization persist in sessions bound to extension install pages, expire after 15 minutes, and are deleted on cancellation. Source changes, revocation, forged pages, or expiry prevent continuation. One installation does not create long-term trust or authorize automatic updates. Without a candidate URL or configured direct-install catalog, return `INSTALLATION_SITE_NOT_CONFIGURED`.

Without this variable, the extension uses the connection entry points on the default installation site. Reload or update the extension after changing its build configuration.

### Environment management entry

Presets may declare the installer's npm package, version/tag, HTTPS registry, and supported core-runtime range through `defaults.management.setup`:

```json
{
  "management": {
    "setup": {
      "package": "@example/mearl-setup",
      "version": "beta",
      "registry": "https://registry.example.com/",
      "runtime": ">=3.0.0-beta.8 <4"
    }
  }
}
```

`management` lives under `defaults` and is saved with inheritance graphs and installation credentials. It is a distribution-management declaration, not user-overridable. Changing it requires explicit preset selection. It describes npm parameters only, rejecting shell commands, extra arguments, and execution hooks.

`mearl guide troubleshooting` and the extension development guide generate management commands from locally verified installation credentials without browser connections, update checks, or factory loading. If no preset is selected, the guide shows the first-time installation entry point. If a preset is selected and its credentials are missing or corrupt, the guide stops command generation.

Installation, updates, and removal share a local lifecycle lease. Component installation uses a separate lease, and both leases cover nested installer processes. Accepted version ranges are rechecked before package commands. Removal may clean out-of-range runtime packages but still requires verifiable records. Existing preset, Skill, and plugin source protections remain.
