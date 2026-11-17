# macOS development

This repository is a customization of Canvas Markdown Side Editor. Keep the existing plugin ID, `canvas-markdown-side-editor`, while developing against its current settings and commands.

## Toolchain

Use Homebrew, fnm, and npm. Node.js is pinned in `.node-version`; npm ships with Node.js.

If Homebrew is already installed, install fnm once:

```zsh
brew install fnm
```

Add this line to `~/.zshrc` once, then open a new terminal. Skip it if already present:

```zsh
eval "$(fnm env --use-on-cd --shell zsh)"
```

From this repository:

```zsh
fnm install
fnm use
node --version
npm --version
npm ci
npm test
npm run build
```

`npm ci` installs the exact dependency versions in `package-lock.json`. Use `npm install` when intentionally changing dependencies, and commit the updated lockfile. No global TypeScript, esbuild, or ESLint installation is needed.

## Load in the development vault

Use a dedicated development vault. The current checkout is inside `dev-vault`, but Obsidian loads plugins only from `.obsidian/plugins/<plugin-id>/`.

On macOS, link this checkout to that location once, running these commands from the repository root:

```zsh
mkdir -p ../.obsidian/plugins
ln -s "$PWD" ../.obsidian/plugins/canvas-markdown-side-editor
```

Skip the link command if the link already exists. If a plugin directory already occupies that path, inspect it before replacing anything. The link lets Obsidian read the generated `main.js`, `manifest.json`, and `styles.css` directly from this checkout. Its local settings file, `data.json`, is ignored by Git.

Run `npm run dev` to generate the root `main.js` used by this link. `npm run build` writes its bundle to `release/` instead.

Open `dev-vault` in Obsidian. Under **Settings → Community plugins**, turn on community plugins if necessary, then enable **Canvas Markdown Side Editor**. If the plugin is not listed, restart Obsidian after building and creating the link.

## Edit and reload

```zsh
npm run dev
```

Leave this watcher running while editing `src/`. It rebuilds `main.js` with inline source maps. Stop it with `Ctrl+C`. Reload the plugin by disabling and enabling it under **Community plugins** after each build; restart Obsidian after manifest changes. The watcher compiles code but does not reload Obsidian or type-check it.

Before finishing a change:

```zsh
npm test
npm run build
```

## Production package

`npm run build` type-checks the source and prepares the complete plugin in the repository's `release/` directory:

```text
release/
  main.js        # minified bundle without source maps
  manifest.json  # plugin identity and compatibility
  styles.css     # plugin styles
  LICENSE        # MIT attribution
```

The manifest, styles, and license are copied from the repository on each successful build. Copy the contents of `release/` into `<vault>/.obsidian/plugins/canvas-markdown-side-editor/`, then reload the plugin in Obsidian. No npm installation is needed inside the installed plugin folder. Production builds leave the root development bundle alone; continue using `npm run dev` for the existing checkout symlink.

For UI changes, also check a Canvas with text and Markdown file cards: edit text, switch cards, verify autosave, and disable the plugin to check cleanup. Tests use an Obsidian mock and do not replace this manual check.

## Repository scope

- Keep source, tests, documentation images, license, TypeScript/build configuration, and the npm lockfile.
- PowerShell release automation and its dedicated tests have been removed. No PowerShell installation is needed.
- `version-bump.mjs`, `versions.json`, and `.npmrc` retain the existing npm versioning workflow for future releases.
- Root `main.js`, `release/`, `node_modules/`, source maps, test coverage, and local plugin settings stay out of commits.

References: [Obsidian plugin tutorial](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin) and [fnm shell setup](https://github.com/Schniz/fnm#shell-setup).

## Verified setup

On 2026-11-16, this Apple Silicon Mac used fnm 1.39.0, Node.js 24.22.0, and npm 11.19.1. fnm's zsh initialization was already configured. The checkout was linked into `dev-vault/.obsidian/plugins/canvas-markdown-side-editor/`.

The initial lockfile could not be installed with `npm ci`: it lacked ESLint peer dependencies and declared Node 16 types incompatible with Vitest. ESLint 8.57.1 is now an explicit development dependency, Node types match Node 24, and TypeScript is 5.9.3. The package files use LF line endings.

The setup was verified with `npm ci`, the test suite, `npm run build`, and watcher startup with `npm run dev`. Start the watcher in your terminal when developing.

The security review refreshed the locked test/build dependencies to Vitest and coverage 5.1.0, Happy DOM 21.0.4, esbuild 0.28.2, and Obsidian API types 1.14.4. `builtin-modules` was replaced with Node's built-in `node:module` export. The test configuration is now `vitest.config.mts`. Node 24 remains pinned in `.node-version`.

`npm ci --ignore-scripts`, the test suite, and `npm run build` pass with this lockfile. The local platform's esbuild binary is supplied as an optional npm dependency; no install script was needed here. `npm audit` reports zero known advisories as of 2026-11-16. Recheck after dependency changes. See [REVIEW.md](REVIEW.md) for details and verification limits.

## Headline mode smoke test

Open `tests/fixtures/headline-mode.canvas` from this checkout in the development vault. Its links use the current vault-relative checkout path, `Canvas-Enhanced-plugin/`; update those paths if the checkout is moved.

1. Run `npm run dev` and reload the plugin. Open the fixture in two Canvas panes.
2. Enable headline mode. The entire-file card should show H1–H6, with metadata/subtitles grouped with their H1. Select it and scroll to reach the later headings.
3. The heading card should show **Selected section 中文**, with its own metadata. Use the native heading picker to try H1–H6, including the formatted heading.
4. The block card should retain its native paragraph. Try narrowing to the list and callout blocks, then choose **Show entire file**.
5. Single-click a note and a text card to select them without opening an editor. Double-click a note to open the whole file in the side panel; double-click a text card to edit it inline. Repeat with headline mode off. Try context-menu Edit, toolbar Edit, and keyboard editing on note cards, including block targets. The image remains outside headline styling.
6. Edit and switch cards/panes, close the panel, and toggle headline mode. Confirm autosave and panel focus cleanup. Check small cards, links, light/dark themes, and plugin disable/re-enable.
7. Resize both the entire-file and heading cards in width and height. Title, badge, category, and subtitle font sizes should stay unchanged; text can wrap or be clipped, and longer outlines remain scrollable. Adjust each size slider and confirm its value is the font size in CSS pixels (H2–H6 outline titles scale down). Zoom the Canvas and confirm the whole card still scales visually. Also check the deep-zoom filename placeholder and the empty-outline placeholder.

On 2026-11-17, the fixed-font resize change passed all 284 tests and the production build. An isolated Chromium check using the current headline renderer, plugin CSS, and installed Obsidian CSS confirmed unchanged font sizes across six card dimensions for entire-file, selected-heading, and empty-outline cards. It also checked H2–H6 proportions, slider-value updates, both placeholders, cleanup, and visual scaling through a Canvas-style transform. This does not replace a live Obsidian smoke test; the active app was showing a different vault, so the development plugin was not reloaded there. The root development bundle and `release/` were rebuilt.

On Obsidian desktop 1.15.1, interactive checks covered note and text selection and editing in both modes, real edits and saves, note double-click and native menu and toolbar Edit, H1–H6 heading targets, the native narrowing menus, block presentation, small cards, and light and dark themes. A fresh long-note card rendered all 84 headings and retained all 169 native preview sections; scrolling reached the last heading, stayed inside the selected card, and panned the Canvas over an unselected card. A cross-pane edit request saved the previous note and opened the next note in the side panel. Disabling the plugin removed its decorations and panel and restored native methods; re-enabling it restored the outline. Return did not trigger a native edit in this runtime, so a keyboard edit path was not verified. Link and zoom gestures were not separately verified.

The earlier interactive pass used the implementation before the security review. The reviewed implementation passes 282 tests in 25 files and `npm run build`; a fresh interactive pass stopped after plugin reload because desktop automation timed out. Do not count the earlier live pass as verification of the new lifecycle changes. Automated regressions cover rendering, edit interception, narrowing transitions, delayed saves, failures, and cleanup. Do not treat these checks as proof of compatibility with every Obsidian version.
