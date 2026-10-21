# dsh-plugin-look-up

macOS-style **Look Up** inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) chat: select a word in any conversation, click the small **Look Up / 查词** chip, and read the definition in a card anchored to the selection.

The definitions come from the **dictionaries you already have in Dictionary.app** — the same local, offline data macOS Look Up reads. No network request, no API key, no accessibility permission.

![version](https://img.shields.io/npm/v/dsh-plugin-look-up) ![license](https://img.shields.io/npm/l/dsh-plugin-look-up)

## What it looks like

```
选中 “serendipity”  ──►  [ 🔍 查词 ]  ──►  ┌─────────────────────────────┐
                                            │ serendipity            ✕   │
                                            │ ˌsɛr(ə)nˈdɪpɪti            │
                                            │ noun formal                │
                                            │ ① uncountable (luck) …     │
                                            │ ② countable …              │
                                            ├─────────────────────────────┤
                                            │ macOS 系统词典 · 本地查询    │
                                            │        复制   在词典中打开  │
                                            └─────────────────────────────┘
```

## Requirements

- macOS 11 or newer.
- DSH Desktop (or the DSH Web GUI served on the same Mac).
- At least one dictionary installed in **Dictionary.app** (Oxford, 现代汉语词典, 新华字典, 牛津英汉汉英词典 … all work). Check with Dictionary.app → Settings → Dictionaries.

## Install

From the DSH plugin CLI:

```bash
dsh plugin --profile <profile> add dsh-plugin-look-up
```

Or install the bundle manually in DSH: **Settings → Plugins → add** and give the package name `dsh-plugin-look-up`, then enable the **Look Up** row.

The package ships a small signed universal helper (`bin/dsh-lookup-dict`, arm64 + x86_64). Nothing is compiled on install.

## Use

1. Select a word or a short phrase in a chat message.
2. Click the **查词 / Look Up** chip that appears next to the selection.
3. Read the definition; **Escape**, an outside click, or scrolling closes the card.
4. `复制` copies the word; `在词典中打开` opens the full entry in Dictionary.app through the `dict:` URL scheme.

The card follows the DSH theme (light/dark, Dream Skin tokens) and the active UI language (中文 / English).

## How it works

| Layer | Responsibility |
| --- | --- |
| `client.js` | Reads the current selection, places the chip/card on `shell.overlay`, renders definitions. |
| `index.js` | Host routes under `/plugin/look-up/*`: loopback-only, bounded JSON body, in-memory cache. |
| `bin/dsh-lookup-dict` | Objective-C helper calling `DCSCopyTextDefinition` from DictionaryServices — the same API behind Look Up. |

Only the selected word is passed to the helper. The helper reads local dictionary data and prints JSON. There is no telemetry, no network call, and the route rejects non-loopback hosts.

### Why not the native Look Up panel?

The system definition panel belongs to the Electron shell: DSH runs its Host in an Electron `utilityProcess` without `webContents`, and the renderer preload exposes a fixed action whitelist, so a plugin cannot call `webContents.showDefinitionForSelection()`. A native helper can *display* the panel, but it steals keyboard focus and dismisses itself when the user clicks back into DSH — a poor fit for a chat overlay. This plugin instead reproduces the content and the interaction inside the conversation, using the same dictionaries.

## Development

```bash
npm run build:helper   # rebuild + re-sign bin/dsh-lookup-dict
npm run check          # syntax-check the two entry points
```

Source of the helper: [`native/dsh-lookup-dict.m`](native/dsh-lookup-dict.m). The ad-hoc signature is applied by the build script; no Developer ID is required for local execution.

## 中文说明

在 DSH 对话里选中一个单词，点击旁边出现的「查词」小胶囊，就在原位弹出释义卡片。词条来自本机「词典」App 里已安装的词典（牛津、现代汉语词典、新华字典等），与 macOS 的 Look Up 同源，**完全离线**，不联网、不需要 API key、不需要辅助功能权限。

- 系统要求：macOS 11+，DSH Desktop 或同一台 Mac 上的 DSH Web GUI。
- 安装：`dsh plugin --profile <profile> add dsh-plugin-look-up`。
- 关闭：Esc、点击卡片外、滚动页面。
- 复制 / 在词典中打开（走 `dict:` URL scheme）。

已知边界：Electron 的系统释义面板无法被第三方插件直接调用（Host 在 utilityProcess 里，渲染层 preload 只暴露固定动作白名单），所以这里用同一个系统词典数据在对话内复刻了交互。

## License

MIT © 2026 huanglianqi
