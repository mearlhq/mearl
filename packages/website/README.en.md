# Product website

[简体中文](README.md) | [English](README.en.md)

The site includes a product overview and separate guides for installation, the first agent task, browser connections, page automation, web debugging, authenticated requests, device and App emulation, EgoLite, Skill plugins, and bb-browser adapters. Simplified Chinese is the default. The language switch opens the matching English page; the English homepage is `en.html`, and other English pages are under `en/`. Both languages follow the browser's color preference until the visitor switches themes.

The standard extension opens `installed.html` under the URL in `packages/preset/installation-site.json` on first installation. The default is `https://mearlhq.github.io/mearl/`. The welcome page includes toolbar, DevTools, and agent setup instructions.

```sh
pnpm dev:website
pnpm build:website
```

The static output is `packages/website/dist/`. Astro uses the configured site URL path as its base. The default `installation.json` is `{"schemaVersion":1}`; without a guide configuration, the welcome page displays its local instructions.

Regular builds read the offline ZIP version and download URL directly from GitHub Pages `config.json`, without GitHub API or CLI authentication. The stable and patch release workflows supply the newly published version through `MEARL_EXTENSION_RELEASE_VERSION` to refresh the Pages configuration. Previews retain the Chrome Web Store link when configuration is unavailable; full builds fail rather than publish an empty update configuration.

Reference pages compile the repository Markdown files listed in `src/lib/reference-docs.mjs`. Update the original English and Simplified Chinese files to change their site content. During compilation, links between selected files use the corresponding site routes. Other relative repository links lead to their source on GitHub.

Lead with the reader's outcome, group the key capabilities or decisions that support it, then show examples and reference details. Keep the introductory page and the guides in that order in both languages.

Position Mearl as a browser work environment for agents. Show a complete workflow: execute a task, inspect requests and logs, verify behavior under simulated conditions, and package the steps as a Skill. Label illustrative examples so they cannot be mistaken for actual runs. Installation follows setup → choose a browser connection → verify a task; the extension is optional for connecting an everyday browser. Describe capabilities within the limits of each connection and Provider.

## Deployment configuration

Set `MEARL_INSTALLATION_CONFIG` to the installation catalog JSON when building the website. To read it from a local file, run:

```sh
MEARL_INSTALLATION_CONFIG="$(cat /path/to/installation.json)" pnpm build:website
```

The catalog uses this format:

```json
{
  "schemaVersion": 1,
  "guide": {
    "url": "https://guide.example.test/installed.html"
  }
}
```

The guide URL must use an HTTPS origin distinct from the public website. When the guide is reachable, the public site shows a banner below its navigation with a link to the custom website. Closing it hides the banner for the current tab session. “Don’t show again” remembers the choice in that browser.

Set the Pages deployment source to GitHub Actions. The `Deploy installation website` workflow runs automatically when a push to `main` changes the website code, build dependencies, reference documents rendered on the site, or deployment configuration. Other pushes skip the website workflow. You can also run it manually after updating the repository secret.

The workflow reads the optional repository secret `MEARL_INSTALLATION_CONFIG`, validates it during the website build, and uploads the configured output to GitHub Pages. An unset secret produces the default configuration. Deployment configuration becomes readable in the deployed `installation.json`. Keep credentials and confidential data out of it.

## Environment detection

The public site sends a cross-origin `HEAD` request to the guide. The probe uses `no-cors` mode, follows redirects, omits credentials, disables caching, and includes a fresh query value. The public site treats an opaque response as a signal of network reachability. The browser hides the HTTP status and response contents. The banner stays hidden if the probe fails, receives no final response within five seconds, or cannot run silently.

The public site automatically probes the guide URL when Local Network Access is already granted. Without a grant, browsers that support Permissions Policy probe from a frame with local network access disabled. This also supports HTTPS guides reached through a proxy. Other browsers with address-space controls only probe public IP space. Leaving the page cancels the probe.

This website is an installation entry point. Installed capability packages must continue working without keeping the website open or online. The web-to-extension installation bridge is a separate integration step.

## Custom extension welcome page

Set one HTTPS website directory URL when building a team extension. The URL can include a subpath.

```sh
MEARL_WEBSITE_URL=https://team.example.com/mearl/ pnpm --filter @mearl/extension... build
```

For local builds, set `MEARL_WEBSITE_URL` in the untracked `packages/extension/.env.local` file. The release workflow reads the GitHub repository variable of the same name. Process environment variables take precedence over local configuration.

On first installation, the extension sends a credential-free `no-cors HEAD` request to `installed.html` under that directory and follows redirects. A completed request within five seconds opens the team welcome page. Otherwise, the extension opens the public welcome page. The probe does not depend on Manifest host permissions for the team website or read response content or HTTP status; an opaque response also indicates network reachability. Users can enable a Preset on the website or run setup.
