# @mearl/plugin-tracking

[简体中文](README.md) | [English](README.en.md)

Pure parsers for Aplus, RUM, and ARMS. Generic request capture, event buffering, and queries remain in the core; this package identifies protocol addresses, normalizes fields, and parses SPM. The default distribution uses the same factory from this package. Installed `tracking.request` / `tracking.decode` / `tracking.spm` capabilities can override it; running batches retain their accepted implementations.

After building, `dist/capability/` contains self-contained Browser / Node modules, a digest manifest, and an example preset. Add the bundle URL to an existing preset's `packages` and install with `@mearl/setup preset apply`; there is no separate plugin registration or permission system. This package only parses captured data and does not send analytics events or upload user data.
