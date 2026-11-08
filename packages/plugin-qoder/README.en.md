# @mearl/plugin-qoder

[简体中文](README.md) | [English](README.en.md)

Optional Qoder integration: local CLI/ACP agents and a Cloud Session API/SSE connector. The core does not depend on this package, register Qoder by default, read PATs, or launch the CLI. This is distributed as an independent npm package.

To use the local Agent, select Qoder in Agent Chat and install the missing components there. A Qoder capability in the selected preset takes precedence. Use a preset to enable cloud pairing.

The built `dist/capability/` contains self-contained Node modules, a digest manifest, and `preset.json`. Use the existing installation flow:

```bash
npx @mearl/setup preset apply ./node_modules/@mearl/plugin-qoder/dist/capability/preset.json
```

If you already use other capabilities, merge the `qoder` package declaration into your existing preset: `preset apply` selects the entire preset. `npm install` alone does not grant permissions or activate capabilities. Package resources can also be distributed over trusted HTTPS URLs.

After installation, local agents are discovered through `agent.provider.qoder`. Uninstalling blocks new sessions while accepted sessions can continue and close. If sessions exist during an update, the new runtime activates only after they close.

Generate a one-time Cloud pairing URL on the agent machine:

```bash
npx @mearl/plugin-qoder pair
```

Follow the output to start `mearl-cloud-connector` on the browser machine, then immediately call Qoder's custom `mearl` tool to complete pairing. The browser machine must have this capability installed and supply `QODER_PERSONAL_ACCESS_TOKEN`. Credentials resolve in this order: process environment, `MEARL_ENV_FILE`, `~/.mearl/.env`, and macOS Keychain `ai.mearl.qoder.pat`. Credentials are never written to pairing URLs, registration records, or logs.

After installing the capability, you can also use `npx @mearl/setup --cloud-mode qoder --yes` with the cloud-server management commands. This package supplies both `cloud.connector.qoder` and `cloud.server.qoder`; missing installations report the missing capability explicitly. ACP permission events use the standard `acp/requestPermission` contract.
