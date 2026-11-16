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
import { Plugin } from 'obsidian';
import { CanvasMdSideEditorSettings, DEFAULT_SETTINGS, migrateLegacyFontSizes } from './settings';
import { migrateLegacyReadOnly, type ViewMode } from './view-mode';
import type { CanvasNode, CanvasLikeView } from './types';
import { CanvasMdSideEditorSettingTab } from './ui/setting-tab';
import { registerCommands } from './commands/register';
import { EditorSession } from './core/editor-session';
import { CanvasInteraction, getActiveCanvasView } from './canvas/interaction';
import { applyHeadlineMode as applyHeadlineModeStyles, removeHeadlineMode } from './features/headline-mode';
import { HeadlineController } from './canvas/headline-controller';

export default class CanvasMdSideEditorPlugin extends Plugin {
  public settings!: CanvasMdSideEditorSettings;

  private session!: EditorSession;
  private interaction!: CanvasInteraction;
  private headline!: HeadlineController;
  private headlineDocuments = new Set<Document>();
  private canvasWork: Promise<void> = Promise.resolve();
  private pendingOpen: { view: CanvasLikeView; id: string; file?: string; mode: ViewMode; promise: Promise<void> } | null = null;
  private lastOpened: { view: CanvasLikeView; id: string; file?: string; mode: ViewMode } | null = null;
  private openRequest = 0;
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

    // Core state machine + canvas event routing
    this.session = new EditorSession({
      app: this.app,
      plugin: this,
      getSettings: () => this.settings,
      persistSettings: (s) => this.saveData(s),
    });
    this.interaction = new CanvasInteraction(this.app, {
      getPanelEl: () => this.session.panel,
      getOpenNodeId: () => this.session.openNodeId,
      save: (view) => this.enqueueCanvasWork(async () => {
        if (this.session.boundView === view) await this.session.save(view);
      }),
      saveAndClose: (view) => {
        this.openRequest++;
        return this.enqueueCanvasWork(async () => {
          if (this.session.boundView === view) await this.session.saveAndClose(view);
        });
      },
      openNode: (view, node) => this.openCanvasNode(view, node),
      requestMarkdownEdit: (view, target) => this.headline.requestMarkdownEdit(view, target),
      allowNativeEditing: (_view, target) => !!target.closest('.canvas-node'),
    });

    this.headline = new HeadlineController(this.app, () => this.settings, (view, node) => this.openCanvasNode(view, node));

    // Serialize view changes with panel opens so saves use the owning Canvas.
    const attach = () => this.enqueueCanvasWork(async () => {
      this.applyHeadlineMode();
      const view = getActiveCanvasView(this.app);
      if (view) {
        await this.attachToCanvas(view);
      } else if (this.session.boundView) {
        // Left the Canvas: persist any unsaved edits to the previous canvas,
        // then drop panel state so a fresh one is built when we return.
        const prev = this.session.boundView;
        if (prev && !(await this.session.saveStable(prev))) return;
        if (this.unloaded) return;
        this.interaction.detach();
        this.session.teardown();
        this.session.boundView = null;
      }
    });
    const refreshAttachment = () => {
      void attach().catch(error => console.error('CanvasMdSideEditor: failed to attach Canvas', error));
    };
    // Native views are not ready until Obsidian restores the workspace.
    this.app.workspace.onLayoutReady(refreshAttachment);

    // Register commands
    registerCommands(this);

    // Re-attach on leaf/view changes
    const ref1 = this.app.workspace.on('active-leaf-change', refreshAttachment);
    const ref2 = this.app.workspace.on('layout-change', refreshAttachment);
    this.registerEvent(ref1);
    this.registerEvent(ref2);
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
      this.session.handleWorkspaceEditorChange(info);
    });
    this.registerEvent(refEdit);
  }

  onunload() {
    this.unloaded = true;
    this.openRequest++;
    this.headline?.dispose();
    const finalSave = this.session?.boundView ? this.session.save(this.session.boundView) : undefined;
    void finalSave?.catch(error => console.error('CanvasMdSideEditor: unload save failed', error));
    for (const doc of this.headlineDocuments) removeHeadlineMode(doc);
    this.headlineDocuments.clear();
    this.session?.teardown(finalSave);
    this.interaction?.detach();
  }

  // Attach the interaction layer to a canvas view. If the existing panel
  // was attached to a destroyed/different container (e.g. user left and
  // returned to a Canvas leaf that Obsidian rebuilt), save any pending
  // edits to the previous canvas and drop the stale panel so the session
  // can rebuild it under the new container. Fixes issue #8.
  private async attachToCanvas(view: CanvasLikeView) {
    if (this.unloaded) return;
    if (this.session.boundView === view && (!this.session.panel || this.session.panel.parentElement === view.containerEl)) return;
    const container: HTMLElement | undefined = view?.containerEl;
    const panel = this.session.panel;
    const stale = !!panel && (!panel.isConnected || (!!container && panel.parentElement !== container));
    if (stale) {
      const prev = this.session.boundView;
      if (prev && prev !== view) {
        if (!(await this.session.saveStable(prev))) return;
      }
      if (this.unloaded) return;
      this.session.teardown();
    }
    if (this.unloaded) return;
    this.interaction.detach();
    this.session.boundView = view;
    this.interaction.attach(view);
  }

  // ---------------------------------------------------------------------
  // Internal delegation shims. Kept as runtime members because the
  // integration tests drive the plugin through them (via `as any`).
  // ---------------------------------------------------------------------

  private async openEditorForNode(view: CanvasLikeView, node: CanvasNode): Promise<void> {
    return this.openCanvasNode(view, node);
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
    this.session.cycleViewMode();
  }

  public async setViewMode(mode: ViewMode): Promise<void> {
    await this.session.setViewMode(mode);
  }

  public applyFontSizes(): void {
    this.session.applyFontSizes();
  }

  public applyDockPosition(): void {
    this.session.applyDockPosition();
  }

  public refreshCardTitle(): void {
    this.session.refreshCardTitle();
  }

  public applyHeadlineMode(): void {
    if (this.unloaded) return;
    const views = (this.app.workspace.getLeavesOfType?.('canvas') ?? [])
      .filter(leaf => !leaf.isDeferred && leaf.view?.containerEl)
      .map(leaf => leaf.view as unknown as CanvasLikeView);
    const documents = new Set([document, ...views.map(view => view.containerEl.ownerDocument)]);
    for (const doc of this.headlineDocuments) if (!documents.has(doc)) removeHeadlineMode(doc);
    for (const doc of documents) applyHeadlineModeStyles(this.settings, doc);
    this.headlineDocuments = documents;
    this.headline?.update(views);
  }

  private enqueueCanvasWork(work: () => Promise<void>): Promise<void> {
    const next = this.canvasWork.then(async () => { if (!this.unloaded) await work(); });
    this.canvasWork = next.catch(() => {});
    return next;
  }

  private openCanvasNode(view: CanvasLikeView, node: CanvasNode): Promise<void> {
    const pending = this.pendingOpen;
    if (pending?.view === view && pending.id === node.id && pending.file === node.file && pending.mode === this.settings.viewMode) return pending.promise;
    const request = ++this.openRequest;
    const mode = this.settings.viewMode;
    const promise = this.enqueueCanvasWork(async () => {
      if (request !== this.openRequest) return;
      if (this.session.boundView === view && this.session.openNodeId === node.id
        && this.lastOpened?.file === node.file && this.lastOpened?.mode === this.settings.viewMode && this.session.panel?.classList.contains('open')) return;
      const previous = this.session.boundView;
      if (previous === view) await this.session.save(previous);
      if (!(await this.headline.waitForNativeSave(view, node))) return;
      if (request !== this.openRequest || this.unloaded) return;
      await this.attachToCanvas(view);
      if (request !== this.openRequest || this.unloaded || this.session.boundView !== view) return;
      if (!(await this.headline.waitForNativeSave(view, node))) return;
      if (request !== this.openRequest || this.unloaded) return;
      const leaf = this.app.workspace.getLeavesOfType?.('canvas').find(candidate => candidate.view === view as unknown);
      if (leaf && this.app.workspace.activeLeaf !== leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
      if (request !== this.openRequest || this.unloaded) return;
      await this.session.open(view, node);
      this.lastOpened = { view, id: node.id, file: node.file, mode };
    });
    this.pendingOpen = { view, id: node.id, file: node.file, mode, promise };
    void promise.finally(() => { if (this.pendingOpen?.promise === promise) this.pendingOpen = null; }).catch(() => {});
    return promise;
  }
}
