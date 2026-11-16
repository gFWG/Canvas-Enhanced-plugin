# Security and compatibility review

Reviewed on 2026-11-16. This covers the local fork, not a new official review of the upstream release.

## Upstream scorecard comparison

The [Community scorecard](https://community.obsidian.md/plugins/canvas-markdown-side-editor#scorecard) reported 194 findings for upstream 2.0.0. Its source links identify commit `fdc9049eab058c5541fca98cda3d0b2b1344d8c1`. It also reports that dependency installation failed, so dependency-dependent checks were skipped. The count includes style and compatibility findings; it is not a count of demonstrated exploits. The table groups the reported finding categories, rather than claiming a fresh official score.

| Reported finding | Current fork and disposition |
| --- | --- |
| Outdated npm lockfile; source review dependency installation failed | Refreshed the lockfile and verified `npm ci --ignore-scripts`. Upgraded the existing test/build tools and API types. A full npm audit went from 15 affected packages to zero known advisories. These were development dependencies, not evidence of a malicious plugin. |
| HTML heading in settings | Removed the redundant plugin-name heading. General settings no longer start with an extra HTML title. |
| Clipboard access | Still intentional: cut writes the selected text; image paste reads only its paste event. There is no background clipboard reader. Cut now waits for copying to succeed and cancels deletion after a document, selection, or focus change. README discloses this behavior. |
| Empty catch blocks | Some remain for optional runtime probes and best-effort cleanup. Confirmed persistence failures now reject instead of being treated as successful saves. Failed saves keep the source buffer and panel available. |
| `any`, broad `Function` typing, speculative Canvas hit tests | Removed unused probing of nine private method names, obsolete delayed selection probing, and the remaining production `any` casts. Narrow runtime interfaces and capability checks remain. |
| Global timers/animation frames; cross-window DOM checks | Affected timers, animation frames, clipboard focus, hit testing and panel listeners use their owning document/window. Headline DOM checks already use the element's own window constructor. Cancelled editor opens cannot remount their content later. |
| `document.createElement` instead of helpers | Safe DOM construction remains where appropriate, using the owning document. No source code inserts user input with `innerHTML`, `outerHTML` or `insertAdjacentHTML`. A helper-name warning alone does not demonstrate an injection vulnerability. |
| CSS `!important`; partial `display: contents` support | Some native Canvas overrides still require these styles. Kept them to preserve the verified headline layouts; did not blanket-rewrite CSS to reduce a lint count. CSS selectors and native layout behavior remain a compatibility risk. |
| `builtin-modules` dependency | Removed; the build uses Node's `builtinModules` export. |
| Aliasing `this` | The zoom wrapper captures its owning interaction and native function explicitly. This local capture is needed across async work and is not a security boundary. It no longer calls through mutable detached state or overwrites another plugin's later wrapper. |
| No declarative settings search definitions | Still applicable on newer Obsidian versions. Existing settings remain usable. Duplicating all settings solely for search was not justified for this focused review. |
| Missing GitHub artifact attestations | Still applicable to unsigned release assets. A local build cannot establish GitHub workflow provenance. No repository publishing or CI attestation workflow was added. |

## Confirmed code issues addressed

- Source-editor saves validate the original file content with `Vault.process`. They preserve external edits on conflict, reject missing files, skip unchanged buffers, and update the saved baseline in queue order. There is no automatic conflict merge.
- Legacy text writes validate node identity and type. A detached Canvas file uses an atomic update; a loaded Canvas without supported update hooks is rejected rather than rewriting behind its in-memory state.
- Image attachment paths and links use `FileManager.getAvailablePathForAttachment` and `generateMarkdownLink`. Clipboard MIME values are mapped to known extensions, including SVG. A delayed paste cannot insert into the next card.
- File renaming uses `FileManager.renameFile`, allowing Obsidian to update links according to user preferences. A late rename completion cannot change the next card's source path.
- Each preview render owns an Obsidian `Component`, released on replacement or panel teardown. Timers, link handlers, drag listeners and pending renders have matching UI lifetimes. Removed a delayed initial render that could overwrite a newer preview.
- Final native-editor saves retain their view until the queued save settles during unload. Normal panel closes still await saving. Failed writes during plugin unload are logged; plugin unload cannot be cancelled to retain its UI.
- Startup uses `Workspace.onLayoutReady`. Unsupported Canvas hooks leave native behavior available in either headline mode. Private wrappers restore original descriptors only while still installed, preserving later wrappers from other plugins.

## Architecture and compatibility decisions

The public APIs cover vault operations, attachment placement, generated links, renaming, Markdown rendering, lifecycle ownership, workspace events and deferred views. These are used directly; no new runtime dependency or general compatibility framework was added.

Two integrations still depend on internals:

| Integration | Why retained | Fallback |
| --- | --- | --- |
| Canvas node lifecycle/edit entry and full-outline preview virtualization | There is no documented API for intercepting Canvas card editing or retaining all virtualized heading sections. These are required for the requested behavior. | Validate the runtime shape; remove incomplete patches and leave unsupported views native with one notice. If only a preview renderer is unavailable, retain that card's native display. |
| Detached `WorkspaceLeaf` and reparented Markdown content | A normal `Workspace.getLeaf` creates a workspace pane. Replacing the embedded editor with one would change docking, floating, and panel behavior. No public embedded Markdown editor constructor is documented. | Validate required methods, use public `loadIfDeferred` when available, cancel superseded opens, and fall back to the source editor with a notice. |

The minimum is now **Obsidian 1.5.7**, where the attachment-placement API became public. This is an API floor, not a claim of interactive testing on every intervening app version. Desktop remains the supported platform. Canvas internals and CSS must be checked again when Obsidian changes them.

## Validation

- `npm ci --ignore-scripts`: clean installation from the refreshed lockfile.
- `npm test`: 282 passing tests across 25 files.
- `npm run test:coverage`: passes with the upgraded coverage provider (90.95% line coverage).
- `npm run build`: TypeScript validation and complete production package in `release/`.
- `npm audit`: zero known advisories for the refreshed dependency graph. An advisory database cannot prove that software is vulnerability-free.
- Added behavior regressions for external edits, missing files, queued saves, teardown during save/open/render/drag, delayed paste/cut, rename completion after card switching, wrapper coexistence, startup timing and native fallback.
- Obsidian 1.15.1 accepted disabling/re-enabling the development plugin. Subsequent desktop automation timed out, so fresh interactive verification of these review changes remains incomplete. Earlier interactive headline/editing results in [Development.md](Development.md#headline-mode-smoke-test) predate this review.

## Official references

- [Plugin guidelines](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Plugin%20guidelines.md): DOM construction, UI headings, vault operations and cleanup.
- [Manage plugin lifecycle](https://docs.obsidian.md/plugins/guides/lifecycle-management): Component ownership, render contexts and element versus global listeners.
- [Obsidian API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts): FileManager, Vault, Workspace, MarkdownRenderer and WorkspaceLeaf contracts.
- [API changelog](https://github.com/obsidianmd/obsidian-api/blob/master/CHANGELOG.md#v157): attachment placement API; deferred-view additions are recorded under 1.7.2.
- [Developer policies](https://docs.obsidian.md/community-directory/developer-policies) and [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins): disclosures and truthful minimum versions.
