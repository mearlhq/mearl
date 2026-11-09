# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## Development Commands

Use Node.js >= 22.23.4 and pnpm 10.34.5, as declared in root `package.json`. Published core runtime packages support Node.js >= 20.18.0; independent Providers declare their own requirements. Run commands from the repository root unless a package directory is specified. Root and package manifests are the source of truth for scripts.

```bash
# Install the locked dependencies
pnpm install --frozen-lockfile

# Build all packages
pnpm build

# Watch extension sources after building dependencies
pnpm --filter @mearl/extension dev

# Build the extension and its workspace dependencies
pnpm --filter @mearl/extension... build

# Develop / build the installation website
pnpm dev:website
pnpm build:website

# Type checking and tests
pnpm typecheck
pnpm test

# Runtime compatibility, after building
pnpm verify:node-runtime
npx --yes --package=node@20.18.0 -- node scripts/verify-node-runtime.mjs

# Bundled Skill resources and browser boundaries
pnpm check:skills
pnpm check:preset-browser
pnpm check:core-browser
```

Do not run separate formatting commands unless requested. Respect configured Git hooks; do not assume a formatter or hook exists without checking this checkout.

### Publishing and Deployment

Publishing packages, changing release versions, changing repository visibility and deploying websites require an explicit user request. Do not rewrite history. Preserve pnpm's clean-worktree, publish-branch and remote synchronization checks; do not use `--no-git-checks`.

Release through `.github/workflows/publish.yml`, following `docs/releases.md`. The `beta` and `patch` channels select versions automatically and inject them into an exported build tree. The `stable` channel requires committed version files and release notes. The separate `.github/workflows/website.yml` deploys on website-related pushes to `main` and also accepts manual runs.

Match validation to the requested scope. Release tasks end with the successful authorized publication and its version and installation or download entry point.

### Reloading the Extension

After building an unpacked extension, reload it through the connected browser:

```bash
mearl __extension_reload
```

Select the intended browser when multiple instances are connected. This calls `chrome.runtime.reload()`; it is equivalent to reloading the extension from the extensions page.

### Refreshing Toolbox Plugins

Toolbox assets are bundled into an immutable snapshot when a plugin is registered. Opening the toolbox checks the registered entry metadata; opening or refreshing a tool checks its bundled resources. Refresh or reopen the tool after editing `skills/<skill>/assets/toolbox/**` or exported `toolbox` metadata.

Register explicitly when adding a plugin, rebinding its source or changing exported metadata only inside an imported module:

```bash
npx @mearl/setup plugin "$PWD/skills/<skill>"
```

Commands capture their source and resources when accepted and execute in isolated workers. New tasks receive source edits; running tasks retain their accepted snapshot. Changes to both toolbox assets and the extension/tool host require an extension build and reload before reopening the tool.

## Architecture Overview

### Repository Map

| Package / directory | Responsibility |
| --- | --- |
| `packages/extension` | Manifest V3 extension; React-compatible source, Preact production rendering, TypeScript and Tailwind CSS |
| `packages/browser-core` | Shared browser/Node logic and authoritative browser protocols |
| `packages/app-profiles` | App profile compilation and document environment simulation |
| `packages/agent-runtime` | Agent contracts, Codex integration and model execution |
| `packages/daemon-core` | Node process lifecycle, registries and logging |
| `packages/provider` | Browser Provider contracts, discovery and runtime |
| `packages/preset` | Preset inheritance, capability declarations, resource snapshots and configuration |
| `packages/native-host` | Native Messaging, CDP and Node capability hosts |
| `packages/client` | Unified SDK/CLI and plugin task, page, state and model services |
| `packages/mcp-server` | MCP tools backed by the shared client |
| `packages/cloud/cloud-server` | Cloud WebSocket routing |
| `packages/cloud/cloud-connector` | Bridge between cloud routing and browser hosts |
| `packages/cloud/cloud-types` | Shared cloud protocol types |
| `packages/plugin-qoder` | Optional Qoder CLI/ACP and cloud connector capability |
| `packages/plugin-tracking` | Tracking protocol parsers and capability bundles |
| `packages/setup` | Installation, updates, removal and plugin registration |
| `skills` | Installable Skills, scripts and toolbox assets |
| `packages/website` | Product site and installation guide |

### Runtime Entry Points

- `packages/extension/manifest.ts` declares entry points and permissions. `src/pages/background/` contains message routing, `agentBridge.ts`, `debuggerManager.ts` and browser action handlers under `agentHandlers/`. Request rules use Declarative Net Request.
- Extension UI lives under `src/pages/`, including `panel`, `popup`, `sidepanel`, `options` and `tool-host`. Content scripts in `src/pages/content-script/` communicate with the background through runtime messages and ports.
- With Agent service enabled, the background starts the Agent Bridge independently of DevTools. CLI, Skills and MCP share the Native Host runtime.
- Local browser calls route from client through local IPC to Native Host, then through Native Messaging to extension handlers or through `src/cdp-backend/` to Chrome. External browsers and devices implement the Provider contract.
- Cloud calls route through client → cloud-server → cloud-connector → browser host. Follow the cloud package READMEs for connection and ownership contracts.
- The plugin service owns commands, tasks, model execution, state and page bindings. Commands use isolated workers; page runtimes are bound to real browser documents. See the client and Native Host READMEs.
- Capability declarations, selected resources and configuration share one accepted snapshot. See `docs/capability-model.md` for ownership, activation and storage contracts.

### Package Boundaries

- Describe the product implemented in this repository. Documentation, examples, fixtures and UI copy must be self-contained and suitable for public distribution. Use neutral example domains and fictional identifiers.
- Write current contracts and behavior directly. Do not use migration diaries, edition comparisons or historical implementation narratives as product documentation. Implement the selected design rather than accumulating compatibility aliases or fallback branches.
- Keep runtime packages under `packages/`, Skills under `skills/<skill>/` and Skill tests under `skills/__tests__/<skill>/`. Preserve public package exports.
- A protocol's owning package is authoritative. Consumers import its public exports; do not create or manually maintain duplicate protocol definitions.
- Preset validation and inheritance must run in browser and Node. Filesystem access, credentials, installation and permission grants belong to hosts.
- Use published package dependencies or this repository's workspace packages. Do not depend on files in another checkout or commit credentials.
- Preserve working behavior until its replacement is validated. Discuss low-reuse custom mechanisms when supporting a use case would add disproportionate complexity to the core.

## Styling Guidelines

- Use Tailwind CSS for extension UI. Standalone Skill tools use bundled HTML/CSS/JS and the host's `--mearl-*` variables.
- Use semantic text, background and border tokens for light/dark themes. Reserve explicit colors for brand and status semantics.
- Use `lucide-react` icons, normally `w-4 h-4` or `w-3 h-3`.
- Preserve entry points, layout, density, available space, shortcuts, focus, loading/error states and performance.

### Skill Toolbox UI

- Inspect a comparable toolbox page before implementing one. Match its density, typography, controls and interaction states.
- Toolbox pages serve people; CLI commands serve agents. Reuse business operations while keeping drafts, selections, previews and other UI-only state in browser memory by default. Persist browser state only for a concrete reopening requirement. Sandbox pages use host-provided capabilities rather than direct storage access.
- Use Node storage for a concrete requirement such as business records, background execution, retry receipts or transport staging, with explicit lifetime and cleanup rules.
- Inherit the host root font size. Normally use `0.75rem` body text, `0.875rem` section headings, 28–32 px controls, 4–6 px radii and 8–12 px spacing. Use theme tokens for surfaces, text, borders, actions and states.
- Prefer built-in icon names or monochrome SVG using `currentColor`. Use explicit-color images only when the tool needs a colored brand image. Follow the client README's `toolbox.icon` contract.
- Provide descriptive placeholders, visible focus/selection, previews and removal, drag/paste feedback, pending progress, retained input on errors and a clear success result. Keep protocol details, request IDs and raw diagnostics out of the main workflow.
- Design Popup and standalone layouts using actual available iframe width and height, including the host header. Short forms should fit one Popup screen: 12 px outer padding, 8–12 px gaps, no repeated host title, flexible internally scrolling content and a visible main action. Standalone tools can offer more editing space with a sensible maximum width.
- Actual UI changes require screenshots at both sizes in light and dark themes. Resolve clipping, density and control-style issues; DOM tests alone do not validate appearance. See `skills/mearl-skill-creator/references/cli-plugin.md`.

## Internationalization

- Maintain primary public documentation in both Simplified Chinese and English, including the root README, package READMEs, main guides under `docs/`, and release notes. Simplified Chinese is the default for the repository and website.
- Use the unsuffixed Markdown filename for Simplified Chinese (for example, `README.md` or `docs/releases.md`) and a sibling `.en.md` file for English (for example, `README.en.md` or `docs/releases.en.md`). Include `README.en.md` in published packages that have a bilingual README.
- Place a `简体中文 | English` language switch immediately below the title in both versions, linking to the corresponding files. Keep documentation links in the reader's selected language when a translated target exists.
- Update both language versions together when changing documented behavior, commands, examples, or requirements. Keep their technical content equivalent.
- Extension UI text uses `t()` from `packages/extension/src/pages/panel/utils/i18n.ts`.
- Add matching keys to `packages/extension/src/locales/zh_CN/messages.json` and `packages/extension/src/locales/en/messages.json`.
- The second argument supplies placeholder substitutions, not fallback text. Pass a string or string array matching the message placeholders.
- Keys must be string literals. Use a switch with literal `t('...')` calls instead of computed keys; helpers needing fallback text accept an already resolved translation.
- Skill tools use the locale supplied by `window.mearl.ready()` and their own translation dictionaries.

## Code Style

- Use functional components with Hooks and direct React API imports.
- Prefer `const`, TypeScript interfaces for component props and destructuring in component signatures.

## Comments

- Describe the current implementation and why it works that way. A reader should not need the previous version to understand it.
- Do not narrate changes with comments such as “改为…”, “不再…”, “之前是…” or old/new implementation comparisons. The diff and commit message record changes.
- Explain enduring rationale, constraints and failure cases where they help the reader.

## Testing

- Place unit/component tests in the nearest `__tests__/` directory, root script tests in `scripts/__tests__/` and Skill tests in `skills/__tests__/<skill-name>/` or `shared/`.
- Keep tests outside installable Skill directories. Use `.test.ts`, `.test.tsx` or `.test.mjs` as configured by the owning Vitest project.
- Add tests for behavior, branching, transformations and meaningful regression risks. Do not add dedicated tests for mechanical list ordering, copy or styling changes.
- Run focused checks first, then the full suite for implementation changes. Do not overlap full tests with builds or other test runs. Use the full root build for changes spanning packages.
- Documentation-only changes need referenced path/command checks and `git diff --check`, not runtime builds or full tests.
- Once relevant checks pass, repeat them only after a material change, failure or unresolved concern. Respect the user's explicit validation scope.

### Focused Validation

```bash
pnpm --filter @mearl/extension test
pnpm --filter @mearl/extension typecheck
pnpm exec vitest run --project skills
```

| Changed area | Minimum focused validation |
| --- | --- |
| Extension | Extension test + typecheck |
| Browser core | Browser-core test + typecheck, plus extension tests |
| App profiles | App-profiles test + typecheck, plus extension and Native Host tests |
| Agent runtime | Agent-runtime test + typecheck, plus client and Native Host tests |
| Daemon core | Daemon-core test + typecheck and affected Node consumers |
| Provider | Provider test + typecheck, plus client and Native Host tests |
| Preset | Preset tests, browser boundary check and affected installation hosts |
| Native Host, client or MCP | Changed package test + typecheck |
| Setup | Setup test + typecheck, plus Native Host tests |
| Cloud types/routing | Changed cloud package tests + typecheck and affected client tests |
| Optional capability package | Changed package test + typecheck and affected host tests |
| Skills | Skills Vitest project and `check:skills` for generated resources |
| Website | Website build + typecheck and affected script tests |

## Version Management

- The `beta` and `patch` channels use automatic version selection and an exported build tree as described in `docs/releases.md`.
- For an explicitly requested release through the `stable` channel, run `pnpm bump <version>`, review all workspace versions, Skill frontmatter and MCP metadata, and prepare both `changelogs/v<version>.md` and `changelogs/v<version>.en.md` before committing.
- After publishing a stable or patch version, verify that its GitHub Release has user-facing change notes and a comparison link. Update the Release and commit the matching Chinese and English entries under `changelogs/` if the workflow generated only a commit list.
- Release notes describe concrete user-visible changes and compatibility requirements. Use plain level-three section headings. Verify website rendering when its changelog presentation changes.
- Commit stable version files and notes together using `chore: v<version>`, matching root `package.json`.

## Git Workflow

- Use the `codex/` prefix for new branches.
- Before committing, ask a review sub-agent to inspect the final diff for regressions, restrained design, unnecessary abstractions and duplicated or redundant logic. Resolve actionable findings first.
- Write commit messages in English. Use Conventional Commit types with optional scope and concise English descriptions; write any body or footer prose in English as well. Release version commits use the `chore: v<version>` exception above.
- Keep descriptions to one short phrase capturing the theme; avoid enumerating every change or restating old/new details.
- Squash completed worktree work into `main`, one commit per completed piece of work; do not create merge commits for routine worktree integration.
- After merging, remove the completed worktree and its branch when they no longer hold other work. Preserve unrelated branches, worktrees and user changes.
