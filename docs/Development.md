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

Verified: `npm ci`, all 222 tests in 20 test files, `npm run build`, and watcher startup with `npm run dev`. The watcher was stopped after verification; start it in your terminal when developing. Plugin enabling and interactive Canvas behavior still require manual verification in Obsidian.

The inherited tests print Happy DOM computed-style errors and an Obsidian `WorkspaceLeaf` mock fallback warning despite passing. The dependency audit reports 15 affected packages (4 moderate, 7 high, 4 critical), including the older Vitest, Happy DOM, and esbuild toolchain. Resolving all findings requires additional dependency upgrades; this setup retains those existing versions. Recheck with `npm audit` as advisories change.
