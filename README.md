# Canvas Markdown Side Editor

[![Release](https://img.shields.io/github/v/release/gFWG/Canvas-Enhanced-plugin)](https://github.com/gFWG/Canvas-Enhanced-plugin/releases)
[![Downloads](https://img.shields.io/github/downloads/gFWG/Canvas-Enhanced-plugin/total)](https://github.com/gFWG/Canvas-Enhanced-plugin/releases)
[![License](https://img.shields.io/github/license/gFWG/Canvas-Enhanced-plugin)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.5.7%2B-7c3aed)](https://obsidian.md)

Edit Canvas Markdown cards from a side panel — live preview, autosave, and no zooming in and out of cramped cards.

This repository maintains a customized version of [Shawn Wu's Canvas Markdown Side Editor](https://github.com/ShawnSWu/Obsidian-Canvas-Markdown-Side-Editor). Install this version through BRAT using `https://github.com/gFWG/Canvas-Enhanced-plugin`.

<img width="1000" alt="Canvas Markdown Side Editor — overview" src="docs/images/overview.gif" />

---

## Why this plugin?

Obsidian Canvas is great for visual thinking, but editing Markdown cards directly inside Canvas is cramped — zoom in, double-click a small card, lose context, repeat. Canvas Markdown Side Editor brings a full Obsidian editor next to the Canvas so you can write comfortably without leaving the big-picture view.

> *Write Markdown with the comfort of a full editor, while keeping the big picture in sight.*

## Recommended Setting for Large Canvases
Headline mode applies to Markdown **file cards** only; standalone text cards keep their normal presentation and editing. A card showing the entire file displays an outline of all H1–H6 headings in document order, with scrolling for longer outlines. Each H1 can use the first `[!note]` after it and before the next H1 for metadata: text before the first `|` becomes the optional badge, text after it becomes the category, and the Note body becomes its subtitle. Without a `|`, the title is the category with no badge.

**Narrow to heading** presents the selected heading at any level as the main headline, with the first Note in that section supplying metadata and subtitle. **Narrow to block** keeps Obsidian's normal block display. Markdown file cards, including narrowed blocks, are edited through the side panel in either mode. The panel edits the whole file.

Headline font sizes stay unchanged when you resize a card, matching native Canvas behavior. The four size sliders set pixel sizes for the title, badge, category, and subtitle; lower outline headings retain their relative sizes. Canvas zoom still scales the whole card visually. Existing slider values are now interpreted as pixels, so you may need to adjust them once for your preferred appearance.

<img width="890" height="663" alt="image" src="https://github.com/user-attachments/assets/62c85f9f-3942-43b5-924a-3f8d8517472d" />

<img width="894" height="247" alt="image" src="https://github.com/user-attachments/assets/ee7b96c2-2740-4d55-b884-038892f872f0" />

````markdown
# Connection and Service Checks

> [!note] P01 | System Check
> Verify that the database, API services, and related dependencies are operating normally.
> Confirm that all required services are running.

## Additional Details

This heading appears in the full-file outline; this body text stays hidden.
````
<img width="1500" height="1000" alt="image" src="https://github.com/user-attachments/assets/d6cb124f-ee1a-4243-ae2c-aad16fe0cfe7" />


---

## Quick Start

1. [Install via BRAT](#option-1--brat-recommended).
2. Open a Canvas in Obsidian.
3. Single-click a Markdown file card or text card to select it. Scroll inside a selected card as needed.
4. Double-click a Markdown file card to edit the whole file in the side panel, or double-click a text card to edit it inline. Click another card or the Canvas background to close the panel and save its changes.

---

## Installation

### Option 1 — BRAT (recommended)

Install this customized version via [BRAT](https://github.com/TfTHacker/obsidian42-brat). BRAT downloads the plugin from this repository's GitHub releases and can check for future updates.

https://github.com/user-attachments/assets/82719127-f450-49e9-b99e-b0700451615d

1. In Obsidian: Settings → **Community Plugins** → enable third-party plugins.
2. Settings → **Community Plugins** → **Browse** → search "BRAT" → Install and enable.
3. Settings → **BRAT** → **Add Beta plugin**.
4. Paste the repo URL: `https://github.com/gFWG/Canvas-Enhanced-plugin` (or `gFWG/Canvas-Enhanced-plugin`).
5. Select the latest release, add the plugin, and enable **Canvas Markdown Side Editor** under Community Plugins if BRAT has not enabled it.

The plugin ID remains `canvas-markdown-side-editor`, so this version uses the same installation folder and settings as the upstream plugin. Use only one repository as the update source for this plugin.

### Option 2 — Manual

Download `main.js`, `styles.css`, and `manifest.json` from the latest [Release](https://github.com/gFWG/Canvas-Enhanced-plugin/releases/latest) and drop them into `<vault>/.obsidian/plugins/canvas-markdown-side-editor/`. Reload Obsidian and enable the plugin.

---

## Compatibility

- Requires Obsidian `1.5.7` or later for the public attachment API. Canvas interaction has been verified on Obsidian desktop 1.15.1; Canvas internals may differ in other versions.
- Desktop only (`isDesktopOnly: true`).
- If native Live Preview is unavailable, the panel uses its source editor and shows a notice. If the required Canvas hooks are unavailable, that view keeps native editing and presentation.

## Privacy and safety

The plugin has no telemetry, account service, background clipboard reading, or direct network requests. It reads notes from the vault and image files supplied by a user-initiated paste, and writes the clipboard when you cut text in the source editor. Notes, attachments, and plugin settings use Obsidian's APIs. Obsidian's renderer and other installed plugins can still load remote content embedded in a note; opening links retains native behavior.

The source editor refuses to overwrite a file that changed externally and retains unsaved text after save errors. Copy your edits before resolving a missing file or an external-change conflict. The native Live Preview editor uses Obsidian's own save handling.

See the [security and compatibility review](docs/REVIEW.md) for the upstream scorecard comparison and remaining internal API dependencies.

---

## Troubleshooting

- **Side editor doesn't open** — double-click a File card linking to a `.md` file. Text cards use Obsidian's inline editor; image, PDF, and link cards do not open the side editor.
- **Headline mode shows an empty outline** — the file has no eligible headings. A faint "No headline" placeholder appears. Missing narrowed targets keep Obsidian's native display.
- **Headline mode compatibility notice** — the Canvas runtime does not expose the required editing hooks. That view retains native behavior; use the supported desktop build.
- **Floating panel opens off-screen after a monitor change** — Settings → reset Dock position to Right, then switch back to Floating.

---

## Changelog

See [GitHub Releases](https://github.com/gFWG/Canvas-Enhanced-plugin/releases) for version-by-version notes.

---

## Contributing

Issues and pull requests welcome at [github.com/gFWG/Canvas-Enhanced-plugin/issues](https://github.com/gFWG/Canvas-Enhanced-plugin/issues).

Local development on macOS (see the [development guide](docs/Development.md) for setup and loading the plugin in Obsidian):

```bash
fnm use        # reads .node-version
npm ci         # installs the locked dependencies
npm run dev    # esbuild watch
npm test       # vitest
npm run build  # type-check and complete plugin in release/
```

Copy the contents of `release/` (`main.js`, `manifest.json`, `styles.css`, and `LICENSE`) into `<vault>/.obsidian/plugins/canvas-markdown-side-editor/` to install a production build.

To publish a BRAT update, create a GitHub release from the tested commit with a tag and title matching the version in `manifest.json` (currently `2.0.0`, without a `v` prefix). Upload `release/main.js`, `release/manifest.json`, and `release/styles.css` as individual release assets. Keep generated files out of Git commits. See the [BRAT developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md) for release requirements.

---

## License

MIT — see [LICENSE](LICENSE).
