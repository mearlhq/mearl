# Explore Mearl Skills

[简体中文](README.md) | [English](README.en.md)

Select a card title for instructions. To install a Skill, use the ID at the bottom of its card as the `--skill` value in the example below.

- [Format converter](format-converter/SKILL.md)

  Convert timestamps and encode or decode Base64, images, and URLs locally.

  `format-converter`

- [Notes](notes-memory/SKILL.md)

  Keep notes with image attachments and give agents memory across sessions.

  `notes-memory`

- [Tab Manager](browser-tab-manager/SKILL.md)

  Summarize and group tabs, and close tabs controlled by Mearl.

  `browser-tab-manager`

- [Web Terminal](web-terminal/SKILL.md)

  Use `mearl terminal` to read browser terminals, send control keys, and get script exit codes from supported terminals.

  `web-terminal`

- [Image compression](tinypng-compress/SKILL.md)

  Paste or drop PNG, JPEG, or WebP images into the Toolbox, then download the files compressed by TinyPNG.

  `tinypng-compress`

- [Design Overlay](design-overlay/SKILL.md)

  Import a design in the Toolbox, align it with the live page, and capture a pixel comparison of the current viewport.

  `design-overlay`

- [Immersive translation](immersive-translate/SKILL.md)

  Translate pages with a local model or the browser and read both languages as you browse.

  `immersive-translate`

## Install Skills

Use Mearl setup to install a Skill and register its plugin. This example installs Format Converter:

```bash
npx @mearl/setup plugin install mearlhq/mearl --github --skill format-converter --yes
```

The Toolbox and Node plugins require compatible local Mearl components. Image compression uploads images to TinyPNG. You can pin a Skill version by specifying a release tag in the installation source.

## Use a web terminal

Open the terminal page in a connected browser. After installation, use `mearl tab_list` to find the tab ID, then discover terminal panes on the page and in iframes.

```bash
npx @mearl/setup plugin install mearlhq/mearl --github --skill web-terminal --yes
mearl tab_list
mearl terminal discover 12345
```

Replace `12345` with the tab ID. `discover` reports whether each pane supports reading, input, and command execution. Use `--paneId` to select a pane when several are present.

## Find more Skills

List the installable Skills in the repository:

```bash
npx skills add mearlhq/mearl --list
```

Install the WeChat mini-program Skill from [WeChat Profile](https://github.com/mearlhq/profile-wechat).
