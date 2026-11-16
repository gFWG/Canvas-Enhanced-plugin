# Repository Guidelines

## Project Structure & Module Organization

This desktop Obsidian plugin opens Canvas Markdown cards in a side editor. `src/main.ts` handles plugin lifecycle and wiring; keep feature logic in focused modules:

- `src/core/`: editor session state and keymap scope.
- `src/canvas/`: interaction routing, geometry, hit testing, and data access.
- `src/editor/`: CodeMirror and Obsidian editor hosts.
- `src/features/`: card titles, headline mode, and image pasting.
- `src/ui/`: panels, previews, and settings UI.

Tests live in `tests/`, including integration regressions and an Obsidian mock in `tests/__mocks__/`. Root `styles.css` contains plugin styles; `docs/images/` holds documentation assets.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run dev`: watch sources and rebuild root `main.js` with esbuild.
- `npm run build`: type-check production sources and generate the complete plugin in `release/` (`main.js`, `manifest.json`, `styles.css`, and `LICENSE`).
- `npm test`: run the Vitest suite once.
- `npm run test:watch`: run tests interactively during development.
- `npm run test:coverage`: generate V8 text and HTML coverage reports.

For manual testing of a production build, copy the contents of `release/` into `<vault>/.obsidian/plugins/canvas-markdown-side-editor/`, then reload Obsidian and enable the plugin. The development watcher still writes root `main.js` for the existing checkout symlink.

## Coding Style & Naming Conventions

Use strict TypeScript, descriptive camelCase functions and variables, PascalCase classes and interfaces, and kebab-case module filenames. `.editorconfig` specifies UTF-8, LF endings, final newlines, and tabs displayed at four columns. Existing TypeScript often uses two spaces; avoid unrelated formatting changes. Follow nearby single-quote and semicolon conventions. `.eslintrc` configures recommended ESLint and TypeScript rules; no lint script is defined.

## Testing Guidelines

Use Vitest with `happy-dom` and the shared `tests/setup.ts`. Name tests `*.test.ts` under the matching subsystem; put cross-module regressions in `tests/integration/`. Add behavioral tests for fixes, including issue numbers where relevant. No numeric coverage threshold is configured. Before submitting, run `npm test` and `npm run build`; manually verify UI changes in Obsidian, including autosave, card switching, and plugin unload.

## Commit & Pull Request Guidelines

Keep commits focused. Keep generated `main.js`, `release/`, dependencies, coverage output, and local `data.json` out of commits. Preserve stable plugin and command IDs, and clean up listeners and editor resources on unload.
