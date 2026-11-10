# General-purpose Skills

[简体中文](README.md) | [English](README.en.md)

Each top-level directory is an independently discoverable Skill. Scripts and toolbox assets ship with their Skill. Tests live in `__tests__/`, outside installation directories.

| Skill | Plugin name | Function |
| --- | --- | --- |
| [mearl](mearl/SKILL.md) | — | Browser control entry point and on-demand operation references |
| [format-converter](format-converter/SKILL.md) | convert | Local timestamps, Base64, images, and URL encoding/decoding |
| [notes-memory](notes-memory/SKILL.md) | notes | Notes, memory across sessions, and image attachments |
| [browser-tab-manager](browser-tab-manager/SKILL.md) | tabs | Tab summaries, smart grouping, and controlled tab cleanup |
| [tinypng-compress](tinypng-compress/SKILL.md) | tinypng | TinyPNG image compression and toolbox |
| [design-overlay](design-overlay/SKILL.md) | overlay | Design overlays, screenshots, and pixel comparisons |
| [immersive-translate](immersive-translate/SKILL.md) | translate | Continuous bilingual reading through a local model or browser |
| [mearl-bbrowser](mearl-bbrowser/SKILL.md) | bbrowser | Run community or custom bb-browser site adapters |
| [mearl-provider-creator](mearl-provider-creator/SKILL.md) | — | Develop and validate external browser and device Providers |
| [mearl-skill-creator](mearl-skill-creator/SKILL.md) | — | Explore websites and create or adapt Skills, CLIs, and toolbox GUIs |

Install with standard Skills tools, for example:

```bash
npx skills add https://github.com/mearlhq/mearl --skill format-converter --global
```

setup combines standard Skills installation and plugin registration:

```bash
npx @mearl/setup plugin install https://github.com/mearlhq/mearl --github --skill format-converter --yes
```

Standard Skills installation and Mearl plugin registration are separate operations. Do not assume the former executes install metadata in frontmatter. setup's plugin install reads the Skills installation results and then registers their plugins. Use `setup plugin "$SKILL_DIR"` to register a local entry point. Install a complete preset with `npx @mearl/setup preset apply <source>`; the preset configures the Skills manager and supports inherited overrides.

These resources use the existing toolbox contract and require a compatible Mearl host. Node plugins and toolbox services require local components. Browser capability packages can load independently in the extension. TinyPNG uploads images to an external compression service as part of its existing functionality.

Installation sources can specify a release tag to pin the Skill version. Register local script plugins with `setup plugin <actual Skill directory>`. The guidance-only `mearl-skill-creator` and `mearl-provider-creator` Skills install through standard Skills tools. EgoLite uses the independent `@mearl/provider-ego` and the general Mearl guide.

## Distribution through skills.sh

Publish complete Skill directories to the public `mearlhq/mearl` GitHub repository, including scripts and generated assets. Standard `skills/<name>/SKILL.md` discovery requires no separate registry manifest or npm package for a Skill.

Validate repository discovery, then install the main Skill:

```bash
npx skills add mearlhq/mearl --list
npx skills add mearlhq/mearl --skill mearl --global
```

The [skills.sh FAQ](https://skills.sh/docs/faq) describes automatic leaderboard listing through installation telemetry. Listing is asynchronous; verify the directory entry instead of treating installation success as proof of listing. Public listing requires an anonymously accessible source repository. Creating a hosted Skills Pack is optional.

Mearl plugin Skills use the combined installer so dependency preparation and registration run together:

```bash
npx @mearl/setup plugin install mearlhq/mearl --github --skill browser-tab-manager --yes
```

Publish the matching Mearl host and extension before advertising Skills that require their new capabilities. See the [release guide](../docs/releases.en.md).

Install the WeChat mini-program Skill from [WeChat Profile](https://github.com/mearlhq/wechat-profile).
