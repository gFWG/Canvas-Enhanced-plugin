# Headline mode implementation plan

Implementation and interactive verification are complete for the exercised paths, as recorded in [Development.md](Development.md#headline-mode-smoke-test). Keyboard edit, link, and zoom gestures were not separately verified in the live runtime.

## Required behavior

A note is a Canvas file node referencing a Markdown file. Headline mode changes only these nodes.

| State | Card presentation | Native inline editing |
| --- | --- | --- |
| Mode off, Markdown note | Native presentation | Side panel |
| Either mode, standalone text card | Native presentation | Native inline editor |
| Either mode, other node type | Native presentation | Native behavior |
| Mode on, Markdown note showing the entire file | All H1–H6 headings in document order; metadata for H1 sections only | Blocked; edit through the side panel |
| Mode on, Markdown note narrowed to a heading | Selected H1–H6 presented as the primary headline, with its section's metadata | Blocked; edit through the side panel |
| Mode on, Markdown note narrowed to a block | Native block presentation | Blocked; edit through the side panel |
| Mode on, known Markdown note with an unresolved target or unavailable metadata | Native presentation until resolution succeeds | Blocked; edit through the side panel |

Apply these content rules:

- In entire-file view, show each heading from the note's own content. Exclude headings inside embedded files and callouts from the outline. Hide ordinary body content except qualifying subtitles.
- Each H1 may use the first non-nested `[!note]` after it and before the next H1. Preserve the existing first-`|` badge/category parsing and callout-body subtitle. H2–H6 receive no independent metadata in this view.
- In heading-narrowed view, show only the selected heading as the primary headline. Treat any selected level like H1: use the first qualifying Note in its section, ending at the next heading of equal or shallower level.
- Show `No headline` only for an entire file that genuinely has no eligible headings. Preserve native presentation for missing or unresolved narrowed targets.
- Entire-file outlines scroll when necessary. Keep the compact layout for a single selected heading.
- In either mode, single-click selects a Markdown note or text card without opening its editor. Double-click opens a note in the side panel or a text card in its native inline editor. Selected cards retain native inner scrolling; an unselected card allows Canvas panning.

## Implementation boundaries

- Reuse Obsidian's rendered Markdown, heading resolution, and native narrowing commands. Do not introduce a second Markdown parser.
- Keep rendering separate from editing permission. A block-narrowed note has native presentation and still has its inner editor blocked.
- Keep the current side panel's whole-file editing and autosave behavior. Never save a narrowed excerpt as the complete file.
- Preserve setting keys, plugin/command IDs, and the existing `release/` build workflow.
- Add no dependencies, generic patching framework, event bus, polling loop, or parallel editor implementation.
- Target the current desktop Obsidian build first. If required runtime hooks are unavailable, leave that view native and show one compatibility notice. Do not install an incomplete collection of event-based edit blockers.

## Code ownership

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Explicit optional `subpath` and minimal runtime shapes needed by this feature. |
| New `src/canvas/headline-controller.ts` | Per-view node access, edit guards, refresh scheduling, and lifecycle cleanup. Keep private Canvas access here. |
| `src/features/headline-mode.ts` | Heading selection, card decoration, metadata rows, and removal of owned DOM changes. Accept explicit card context instead of scanning every Canvas node globally. |
| `src/canvas/interaction.ts` | Existing pointer/focus routing; remove conflicts with the new guard. |
| `src/main.ts` | Create/dispose the controller, reconcile loaded Canvas views, and connect settings and the existing editor session. |
| `styles.css` | Styles scoped to decorated cards, with separate outline and selected-heading layouts. |

Start with one new production module. Extract a pure selection helper only if it materially simplifies `headline-mode.ts`; avoid building a general Canvas abstraction.

## Execution steps

### 1. Confirm the runtime contract

- [x] In the development vault, create one fixture note containing two H1 sections, H2–H6, Note callouts, duplicate/formatted/non-ASCII headings, and paragraph/list/callout blocks. Add full-file, heading-narrowed, and block-narrowed instances, a text card, and an image. Open two Canvas panes.
- [x] Verify the owning view's node map, `nodeEl`, live `getData()`, and `subpath`. Use node objects and owning views as identity; do not depend on DOM node-ID attributes.
- [x] Verify note double-click and native menu and toolbar Edit requests reach the side panel. Return did not trigger native editing during the live check; keyboard and embedded edit requests are covered by automated tests rather than a live gesture.
- [x] Locate the separate selected-heading title (`.inline-title`) and its header ancestors, as well as the narrowed preview body. Heading-element and plain-text forms are covered by automated tests.
- [x] Verify the native commit/preview operation for an already-active editor and the node-creation hook that runs before its first edit request.

**Complete when:** these few hooks work on the running build. Resolve any mismatch here before writing the controller; do not expand into speculative compatibility machinery.

### 2. Implement the controller and shared classification

- [x] Add `subpath?: string` to `CanvasNode`. Define only the runtime members verified in step 1.
- [x] Track loaded Canvas views with one small state object per view. Discover them through workspace lifecycle events and reconcile additions/removals without repeatedly reattaching unchanged views.
- [x] Associate each node with its own element and current data. Separate `isMarkdownNote` from presentation kind: `native`, `outline`, or `heading`. A block subpath selects native presentation.
- [x] Read live node data during decisions. Resolve heading targets through Obsidian's metadata cache and `resolveSubpath`; missing metadata must not remove the edit restriction from a known Markdown note.
- [x] Install reversible per-node edit guards for existing nodes and synchronously through the verified node-addition hook for new nodes. Keep wrapper installation/removal in a small local helper.
- [x] Use one scheduled refresh per affected view, driven by node lifecycle, preview DOM changes, and relevant file/metadata updates. Avoid disk reads for every gesture and avoid reprocessing unrelated views.

**Complete when:** node classification and guard installation remain correct after adding, removing, swapping, or narrowing notes in either pane.

### 3. Refactor rendering around explicit card context

- [x] Replace global `.canvas-node` scanning and single-title selection with a per-card refresh accepting current presentation kind and resolved heading information.
- [x] For entire-file view, retain all eligible H1–H6 elements in order. Associate each H1 with its own qualifying Note. Place its metadata row before that H1 and visually group its subtitle with that H1, even when the source Note follows a lower-level heading. Preserve relative heading order through layout ordering rather than relocating Obsidian-owned blocks. Key injected metadata by its owning heading, reusing or repositioning rows and removing obsolete rows.
- [x] For heading-narrowed view, preserve the selected native title and its visible ancestors even when the title is outside the preview body. Find its Note in the narrowed section separately. If the native title is genuinely absent after rendering, use one plugin-owned text title from the resolved heading. Avoid duplicate titles.
- [x] For native presentation, remove all plugin-owned decoration and metadata from that card. Leave native block content and errors intact.
- [x] Scope every headline CSS rule to an explicit decorated-card class, including title hiding, padding, size containers, and placeholders. Do not rely on the global mode class alone.
- [x] Give entire-file outlines readable heading hierarchy and vertical scrolling without title/subtitle shrinking or clipping away later headings. Reuse existing subtitle ellipsis only for the compact selected-heading layout; do not add multi-subtitle clipping machinery to the outline.
- [x] Keep every native preview section available in a full-file outline, including sections normally detached by preview virtualization. Use the native preview scroller and restore its original virtualization when leaving the outline.
- [x] Reconcile markers and rows without unnecessary DOM writes. Keep observers from repeatedly refreshing in response to unchanged plugin decoration.

**Complete when:** all three presentations render correctly through entire file → heading → block → entire file transitions, with no stale styling or metadata.

### 4. Route native edit requests to the existing side panel

- [x] At edit entry, check the live node type. For a Markdown note in either mode, skip native activation and request the existing side panel. For other calls, invoke the original method with its receiver, arguments, return behavior, and exceptions preserved.
- [x] Route using the node's owning view. Save the previously bound session before activating/binding another Canvas pane. Reuse session-generation checks and deduplicate requests so a native timer and the existing pointer handler cannot open conflicting sessions.
- [x] Keep the lock independent of panel visibility and narrowing type. Block-narrowed notes remain locked; excluded text cards remain editable.
- [x] Route a single click to selection and a double click to the appropriate editor for notes and text cards in both modes. Preserve drag, zoom, and save protections.
- [x] When enabling the mode during native editing, commit through the verified native lifecycle and leave that editor before applying decoration. If this cannot be done safely, leave the affected view native and report the compatibility failure; do not discard text or claim an active lock.
- [x] Preserve selection, movement, resize handles, connections, links, context menus, and native narrowing. Keep all editing inside the side panel unrestricted.

**Complete when:** every verified native edit entry opens the side panel without activating an inner editor, including in an inactive Canvas pane.

### 5. Finish lifecycle handling and user-facing descriptions

- [x] Clear obsolete decoration when preview roots are replaced. Discard delayed work whose view, file, subpath, or render generation changed.
- [x] Observe each managed view's own document/container. Release removed nodes and closed views promptly.
- [x] On mode disable, remove headline decoration and restore preview virtualization while retaining the click and editing policy. On plugin unload, cancel scheduled work, disconnect observers, remove owned DOM changes, and deactivate all wrappers. Restore an original property/descriptor only when this plugin's wrapper is still installed; preserve wrappers added later by other plugins.
- [x] Test unload/reload and both wrapper-installation orders with a small simulated second wrapper. No active restriction may remain after unloading.
- [x] Update `src/settings.ts`, `src/ui/setting-tab.ts`, and README descriptions to explain notes-only rendering, all-heading outlines, narrowing behavior, and panel-only editing. Keep existing IDs and setting keys.

**Complete when:** disabling headline mode restores native presentation, unloading restores native behavior, and the descriptions match the implemented rules.

### 6. Validate and package

Update tests that assert the previous behavior. Add focused behavioral coverage using the existing Vitest setup:

| Area | Required coverage |
| --- | --- |
| Scope | Markdown notes versus text/media/link/group nodes; missing identity; same node ID in two views; unsupported runtime hooks. |
| Outline | H1–H6 order, multiple H1 sections, H2-only note, heading-free note, H1 metadata ownership including a Note after an H2, nested embeds/callouts, accessible overflow. |
| Narrowing | Selected H1–H6, separate native title, plain-text title fallback, duplicate/formatted/non-ASCII targets, block presentation, unresolved metadata, all mode transitions. |
| Editing | Each native entry path, panel open/closed, already-active editor, newly created notes, inactive pane, rapid switching, excluded cards, mode off. |
| Persistence and cleanup | Whole-file saves, autosave/card switching, preserved subpaths, preview remounts, mode toggles, unload/reload, and wrapper coexistence. |

- [x] Run `npm test` and `npm run build`.
- [x] Verify the fixture in Obsidian: double-click, menu and toolbar edit paths, narrowing, autosave, card switching, two panes, small cards, scrolling versus Canvas pan, light/dark themes, and unload/re-enable. Cross-pane routing was exercised with a native edit request. Live keyboard edit, link, and zoom gestures remain unverified.
- [x] Verify source content is preserved. Temporary interactive fixtures were removed after their test tabs were closed; the reusable note fixture contains no verification markers.
- [x] Verify `release/` contains `main.js`, `manifest.json`, `styles.css`, and `LICENSE`.
- [x] Record the app version actually tested. Adjust compatibility claims or the manifest minimum only to match the supported and verified runtime contract.

**Done when:** all requested behaviors pass on the supported build, the existing panel workflow remains reliable, cleanup restores native behavior, and the production package builds successfully.
