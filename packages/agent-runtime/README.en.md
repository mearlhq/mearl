# @mearl/agent-runtime

[简体中文](README.md) | [English](README.en.md)

Local Codex app-server integration, generic Agent Provider contracts, and managed one-shot model execution. Qoder ACP is supplied by the optional [`@mearl/plugin-qoder`](../plugin-qoder/README.en.md).

This package provides independently usable local Agent adapters, model calls, and sessions. It depends on daemon-core, browser-core's protocol-only contracts, and public Provider SDKs, without depending on the browser extension, installer, or browser execution host.

Model, session, and Skill type contracts are maintained by browser-core and imported through protocol-only subpaths. This package also publicly exports them. Browser UIs and other consumers should reuse the public contracts instead of maintaining duplicate definitions.

Each `runCodexModel` call owns an independent Provider process and exposes only the read-only Agent mode declared in its capabilities. The host validates structured results, persists tasks, and terminates process trees. A pure generation mode requires a Provider with reliable tool-free execution support.
