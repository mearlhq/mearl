# Product website

[简体中文](README.md) | [English](README.en.md)

The site includes a product overview and separate guides for installation, the first agent task, browser connections, page automation, web debugging, authenticated requests, device and App emulation, EgoLite, Skill plugins, and bb-browser adapters. Simplified Chinese is the default. The language switch opens the matching English page; the English homepage is `en.html`, and other English pages are under `en/`. Both languages follow the browser's color preference until the visitor switches themes.

The extension opens `installed.html` under the URL in `packages/preset/installation-site.json` on first installation. The default is `https://mearlhq.github.io/mearl/`. The welcome page includes toolbar, DevTools, and agent setup instructions. Configured installation-guide detection runs on the welcome page.

```sh
pnpm dev:website
pnpm build:website
```

The static output is `packages/website/dist/`. Astro uses the configured site URL path as its base. The default `installation.json` is `{"schemaVersion":1}`; without a guide configuration, the welcome page displays its local instructions.

The build resolves the offline ZIP from GitHub Releases. It uses the latest stable ZIP when available and otherwise selects the newest published prerelease with a ZIP. The Chrome Web Store link is available even when the build cannot resolve a ZIP. For private repositories, use `GH_TOKEN` or sign in with `gh auth login` for local previews.

Reference pages compile the repository Markdown files listed in `src/lib/reference-docs.mjs`. Update the original English and Simplified Chinese files to change their site content. During compilation, links between selected files use the corresponding site routes. Other relative repository links lead to their source on GitHub.

Lead with the reader's outcome, group the key capabilities or decisions that support it, then show examples and reference details. Keep the introductory page and the guides in that order in both languages.

## Deployment configuration

Set `MEARL_INSTALLATION_CONFIG_FILE` to an absolute JSON file path when building the website:

```json
{
  "schemaVersion": 1,
  "guide": {
    "url": "https://guide.example.test/installed.html",
    "registry": "https://registry.example.test/"
  }
}
```

The guide and npm registry must use HTTPS origins distinct from the public website. The registry is a directory URL without a query or fragment; it need not share the guide origin. The site redirects only to the configured guide URL after a successful npm ping; URL parameters and ping responses cannot supply a destination, command or plugin source.

Set the Pages deployment source to GitHub Actions. The `Deploy installation website` workflow runs automatically when a push to `main` changes the website code, build dependencies, reference documents rendered on the site, or deployment configuration. Other pushes skip the website workflow. You can also run it manually after updating the repository secret.

The workflow reads the optional repository secret `MEARL_INSTALLATION_CONFIG`, validates it during the website build, and uploads the configured output to GitHub Pages. An unset secret produces the default configuration. Deployment configuration becomes readable in the deployed `installation.json`. Keep credentials and confidential data out of it.

## Environment detection

The page checks the registry's standard `-/ping` endpoint and requires a successful JSON response with `pong: true`. The registry must allow the configured website origin via CORS. No dedicated guide probe page or frame protocol is needed. This is the browser equivalent of the existing setup environment check using `npm ping`; the npm registry used for downloads remains a separate installation concern.

Requests omit credentials, refuse redirects, disable cache and carry a fresh query value. Responses are bounded to 4 KiB. Login HTML, fallback JSON, CORS failures, redirects and failed requests keep the public guide visible. A successful ping determines network reachability, not account identity or authorization; the redirect destination is always the configured guide URL.

The welcome page automatically probes the registry when Local Network Access is already granted. Without a grant, browsers that support Permissions Policy probe from a frame with local network access disabled. This also supports HTTPS registries reached through a proxy. Other browsers with address-space controls only probe public IP space automatically. Click **Check guide connection** when local network access is required. The network deadline is five seconds. A pending permission request has a separate, cancellable 120-second deadline. A retry creates a new request, and navigation releases the current attempt. The direct guide link and local instructions remain available.

This website is an installation entry point. Installed capability packages must continue working without keeping the website open or online. The web-to-extension installation bridge is a separate integration step.
