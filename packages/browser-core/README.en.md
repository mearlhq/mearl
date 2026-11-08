# @mearl/browser-core

[简体中文](README.md) | [English](README.en.md)

Page control logic and protocols shared by browsers and Node: DOM/AX snapshots, action observation, input, scrolling, navigation, request serialization, capture cursors, device simulation, generic device appearance, Cookie/domain permissions, and plugin task, page, and state contracts. Modules have no browser extension or native process installation side effects.

The core includes no preset App identities. The host validates profile IDs against its active capability catalog. App profile schemas, explicit options, revisions, and page runtime bindings are data contracts; independent capability packages supply complete bridge implementations.

The built-in installer at `@mearl/browser-core/appProfileRuntime` synchronizes only UA, navigator.appVersion, navigator.platform, and touch points. It does not install App bridges, business globals, container stacks, or authorization handlers. With a pageRuntime binding, the host must prepare the exact code from the installed capability package and execute it through the page runtime dispatcher; the base installer cannot substitute for this. See [browser bundles](../../docs/browser-bundles.en.md#page-runtimes) for resource preparation and dispatch.

The default proxy authorization addresses are localhost and 127.0.0.1. Hosts obtain permission for other sites and pass them in the authorization list. The core includes Aplus/RUM/ARMS event parsers; additional parsers register through capability packages.

Agent contracts are defined in agentChat.ts, agentSkills.ts, and pluginModels.ts and exported through the corresponding subpaths. agent-runtime uses these contracts to avoid duplicate definitions. Serializable page functions remain self-contained for shared use by the Extension and CDP.
