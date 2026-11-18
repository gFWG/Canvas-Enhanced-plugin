/*
 Canvas Markdown Side Editor
 - Detect clicks on Canvas Markdown (text) cards
 - Open a right-side editor styled like Obsidian
 - Save edits back to the Canvas file on background click or switching cards

 This file is the plugin's lifecycle + wiring only. Feature logic lives in:
   core/editor-session.ts    open/save/close state machine + panel lifecycle
   canvas/interaction.ts     canvas DOM event routing + single-click detection
   canvas/{geometry,data,hit-test}.ts   canvas geometry / data / node lookup
   editor/*                  editor primitives (CM6 + Live Preview leaf host)
   features/*                orthogonal features (card title, paste, headline)
   ui/*                      panel, preview, settings tab
*/
import { Plugin, type WorkspaceParent } from 'obsidian';
import { CanvasMdSideEditorSettings, DEFAULT_SETTINGS, migrateLegacyFontSizes } from './settings';
import { migrateLegacyReadOnly, nextViewMode, type ViewMode } from './view-mode';
import type { CanvasNode, CanvasLikeView } from './types';
import { CanvasMdSideEditorSettingTab } from './ui/setting-tab';
import { registerCommands } from './commands/register';
import { WindowEditor } from './core/window-editor';
import { isCanvasView } from './canvas/interaction';
import { applyHeadlineMode as applyHeadlineModeStyles, removeHeadlineMode } from './features/headline-mode';
import { HeadlineController } from './canvas/headline-controller';

export default class CanvasMdSideEditorPlugin extends Plugin {
  public settings!: CanvasMdSideEditorSettings;

  private windows = new Map<Document, WindowEditor>();
  private headline!: HeadlineController;
  private closedWindows = new WeakSet<Document>();
  private headlineDocuments = new Set<Document>();
  private unloaded = false;

  async onload() {
    // Load settings and register settings tab
    let raw: Record<string, unknown> = {};
    try {
      const data = (await this.loadData()) as Record<string, unknown> | null;
      if (data && typeof data === 'object') raw = data;
    } catch {}

    // Issue #16 migration: collapse legacy `readOnly` boolean into
    // `viewMode` BEFORE merging with DEFAULT_SETTINGS, so the default
    // `viewMode: 'live'` doesn't mask a legacy `readOnly: true` save.
    // Also retires the removed 'both' split mode to 'live', and folds the
    // old font settings (editorFontSize / baseFontSize × panelFontScale)
    // into the single `fontSize` px value.
    // Idempotent; running on already-migrated data is a no-op.
    const hadLegacy =
      'readOnly' in raw
      || raw.viewMode === 'both'
      || 'editorFontSize' in raw
      || 'previewFontSize' in raw
      || 'baseFontSize' in raw
      || 'panelFontScale' in raw;
    migrateLegacyReadOnly(raw);
    migrateLegacyFontSizes(raw);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw) as CanvasMdSideEditorSettings;
    if (hadLegacy) {
      try { await this.saveData(this.settings); } catch {}
    }

    this.addSettingTab(new CanvasMdSideEditorSettingTab(this.app, this));

    this.headline = new HeadlineController(this.app, () => this.settings, (view, node) =>
      this.windowEditor(view.containerEl.ownerDocument).openCanvasNode(view, node));
    const refreshAttachment = () => this.refreshWindows();
    // Native views are not ready until Obsidian restores the workspace.
    this.app.workspace.onLayoutReady(refreshAttachment);

    // Register commands
    registerCommands(this);

    // Re-attach on leaf/view changes
    const ref1 = this.app.workspace.on('active-leaf-change', refreshAttachment);
    const ref2 = this.app.workspace.on('layout-change', refreshAttachment);
    this.registerEvent(ref1);
    this.registerEvent(ref2);
    this.registerEvent(this.app.workspace.on('window-open', refreshAttachment));
    this.registerEvent(this.app.workspace.on('window-close', (_workspaceWindow, win) => {
      this.closedWindows.add(win.document);
      this.windows.get(win.document)?.dispose();
      this.windows.delete(win.document);
      this.applyHeadlineMode();
    }));
    // Narrowed targets can resolve after their note's metadata becomes ready.
    if (this.app.metadataCache?.on) {
      this.registerEvent(this.app.metadataCache.on('changed', () => this.applyHeadlineMode()));
      this.registerEvent(this.app.metadataCache.on('resolved', () => this.applyHeadlineMode()));
    }

    // When the leaf-hosted editor changes, schedule a preview re-render so
    // the right-hand pane stays in sync. The 'editor-change' event fires
    // for any markdown view in the workspace; the session filters to the
    // file it currently has embedded.
    const refEdit = this.app.workspace.on('editor-change', (_editor, info) => {
      for (const editor of this.windows.values()) editor.session.handleWorkspaceEditorChange(info);
    });
    this.registerEvent(refEdit);
  }

  onunload() {
    this.unloaded = true;
    this.headline?.dispose();
    for (const doc of this.headlineDocuments) removeHeadlineMode(doc);
    this.headlineDocuments.clear();
    for (const editor of this.windows.values()) editor.dispose();
    this.windows.clear();
  }

  private windowEditor(doc: Document): WindowEditor {
    let editor = this.windows.get(doc);
    if (!editor) {
      editor = new WindowEditor(this, this.headline);
      this.windows.set(doc, editor);
    }
    return editor;
  }

  private refreshWindows(): void {
    if (this.unloaded) return;
    this.applyHeadlineMode();
    const workspace = this.app.workspace;
    const active = workspace.activeLeaf;
    const selected = new Map<Document, CanvasLikeView | null>();
    for (const leaf of workspace.getLeavesOfType?.('canvas') ?? []) {
      if (leaf.isDeferred || !leaf.view?.containerEl) continue;
      const doc = leaf.view.containerEl.ownerDocument;
      if (selected.has(doc) || this.closedWindows.has(doc)) continue;
      const recent = active?.view?.containerEl?.ownerDocument === doc
        ? active : workspace.getMostRecentLeaf?.(leaf.getRoot() as WorkspaceParent) ?? leaf;
      selected.set(doc, !recent.isDeferred && isCanvasView(recent.view)
        ? recent.view as unknown as CanvasLikeView : null);
    }
    // A leaf can be moved intact. Transfer its editor with the DOM when
    // possible, retaining the mounted buffer and pending saves.
    for (const [doc, editor] of [...this.windows]) {
      const destination = editor.session.boundView?.containerEl.ownerDocument;
      if (destination && destination !== doc && !this.windows.get(destination)?.session.panel) {
        this.windows.get(destination)?.dispose();
        this.windows.delete(doc);
        this.windows.set(destination, editor);
      }
    }
    for (const doc of new Set([...this.windows.keys(), ...selected.keys()])) {
      const editor = this.windowEditor(doc);
      void editor.refresh(selected.get(doc) ?? null)
        .catch(error => console.error('CanvasMdSideEditor: failed to attach Canvas', error));
    }
  }

  // ---------------------------------------------------------------------
  // Internal delegation shims. Kept as runtime members because the
  // integration tests drive the plugin through them (via `as any`).
  // ---------------------------------------------------------------------

  private async openEditorForNode(view: CanvasLikeView, node: CanvasNode): Promise<void> {
    return this.windowEditor(view.containerEl.ownerDocument).openCanvasNode(view, node);
  }

  private get session() { return this.windows.get(document)?.session; }
  private get interaction() { return this.windows.get(document)?.interaction; }
  private get canvasWork() { return Promise.all([...this.windows.values()].map(editor => editor.canvasWork)); }
  private attachToCanvas(view: CanvasLikeView) {
    return this.windowEditor(view.containerEl.ownerDocument).attachToCanvas(view);
  }

  private get panelEl(): HTMLElement | null {
    return this.session?.panel ?? null;
  }

  private get previewRootEl(): HTMLElement | null {
    return this.session?.previewRoot ?? null;
  }

  private get cmView() {
    return this.session?.cmView ?? null;
  }

  // ---------------------------------------------------------------------
  // Public API used by commands and the settings tab
  // ---------------------------------------------------------------------

  public cycleViewMode(): void {
    void this.setViewMode(nextViewMode(this.settings.viewMode));
  }

  public async setViewMode(mode: ViewMode): Promise<void> {
    const previous = this.settings.viewMode;
    this.settings.viewMode = mode;
    try { await this.saveData(this.settings); } catch {}
    await Promise.all([...this.windows.values()].map(editor => editor.session.applyViewMode(mode, previous)));
  }

  public applyFontSizes(): void {
    for (const editor of this.windows.values()) editor.session.applyFontSizes();
  }

  public applyDockPosition(): void {
    for (const editor of this.windows.values()) editor.session.applyDockPosition();
  }

  public refreshCardTitle(): void {
    for (const editor of this.windows.values()) editor.session.refreshCardTitle();
  }

  public applyHeadlineMode(): void {
    if (this.unloaded) return;
    const views = (this.app.workspace.getLeavesOfType?.('canvas') ?? [])
      .filter(leaf => !leaf.isDeferred && leaf.view?.containerEl && !this.closedWindows.has(leaf.view.containerEl.ownerDocument))
      .map(leaf => leaf.view as unknown as CanvasLikeView);
    const documents = new Set([document, ...views.map(view => view.containerEl.ownerDocument)]);
    for (const doc of this.headlineDocuments) if (!documents.has(doc)) removeHeadlineMode(doc);
    for (const doc of documents) applyHeadlineModeStyles(this.settings, doc);
    this.headlineDocuments = documents;
    this.headline?.update(views);
  }
}
