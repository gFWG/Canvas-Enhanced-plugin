// Obsidian has no public API for an embedded Markdown editor. Keep the
// optional detached-leaf integration here; callers fall back to CM6 when
// its runtime contract is unavailable. loadIfDeferred is public since 1.7.2.
import { App, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import type { EditorHost } from './editor-host';

type LeafWithDeferred = WorkspaceLeaf & {
  isDeferred?: boolean;
  loadIfDeferred?: () => Promise<void>;
};

export class MarkdownLeafHost implements EditorHost {
  readonly kind = 'leaf' as const;

  private app: App;
  private leaf: WorkspaceLeaf | null = null;
  private mountEl: HTMLElement | null = null;
  private generation = 0;
  private resizeFrame: number | null = null;
  private frameWindow: Window | null = null;

  constructor(app: App) {
    this.app = app;
  }

  // Open the given .md file in a fresh detached leaf and mount its DOM into
  // `mountEl`. Returns the live `MarkdownView` on success, or null if the
  // runtime refused to construct a detached leaf.
  async open(file: TFile, mountEl: HTMLElement): Promise<MarkdownView | null> {
    // detach clears synchronously, so overlapping opens cannot capture the
    // same generation while awaiting a previous detach.
    void this.detach();
    const generation = this.generation;
    const isCurrent = () => this.generation === generation && this.mountEl === mountEl;
    this.mountEl = mountEl;

    let leaf: WorkspaceLeaf;
    try {
      leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(this.app);
    } catch (e) {
      try { console.error('CanvasMdSideEditor: detached WorkspaceLeaf ctor failed', e); } catch {}
      return null;
    }
    this.leaf = leaf;
    if (typeof leaf.setViewState !== 'function' || typeof leaf.detach !== 'function') {
      await this.detach();
      return null;
    }

    // Force Live Preview regardless of the user's global default by passing
    // `source: false` alongside `mode: 'source'`. (Obsidian exposes "Live
    // Preview" as a sub-state of source mode rather than a top-level mode.)
    try {
      await leaf.setViewState({
        type: 'markdown',
        state: { file: file.path, mode: 'source', source: false } as unknown as Record<string, unknown>,
      });
    } catch (e) {
      try { console.error('CanvasMdSideEditor: setViewState failed', e); } catch {}
      if (isCurrent()) await this.detach();
      return null;
    }
    if (!isCurrent()) return null;

    // Promote a DeferredView placeholder into the real MarkdownView before
    // we read `leaf.view`. On Obsidian < 1.7.2 both isDeferred and
    // loadIfDeferred are undefined and this is a no-op.
    const leafDeferred = leaf as LeafWithDeferred;
    if (leafDeferred.isDeferred && typeof leafDeferred.loadIfDeferred === 'function') {
      try {
        await leafDeferred.loadIfDeferred();
      } catch (e) {
        try { console.error('CanvasMdSideEditor: loadIfDeferred failed', e); } catch {}
        if (isCurrent()) await this.detach();
        return null;
      }
    }
    if (!isCurrent()) return null;
    if (leafDeferred.isDeferred) {
      await this.detach();
      return null;
    }

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || typeof view.save !== 'function'
      || typeof view.getViewData !== 'function' || typeof view.editor?.focus !== 'function') {
      try { console.warn('CanvasMdSideEditor: leaf.view is not a MarkdownView', view); } catch {}
      await this.detach();
      return null;
    }

    // Reparent the view's content area into our editor pane. We pick
    // `contentEl` (not `containerEl`) so the embedded view skips its own
    // tab header / breadcrumb chrome — the side panel already has its own
    // toolbar. The leaf still owns the view; we're just giving its DOM a
    // different visual home.
    const embedEl = (view.contentEl ?? view.containerEl) as HTMLElement;
    mountEl.empty();
    mountEl.appendChild(embedEl);

    // Nudge the editor to recompute its size against the new parent.
    try { view.onResize(); } catch {}
    // Some Obsidian builds don't lay out the editor until they think the
    // view is "loaded" in the workspace. Trigger a manual measure on the
    // next frame too, just in case.
    const win = mountEl.ownerDocument.defaultView;
    if (win) {
      this.frameWindow = win;
      this.resizeFrame = win.requestAnimationFrame(() => {
        this.resizeFrame = null;
        if (isCurrent()) { try { view.onResize(); } catch {} }
      });
    }

    return view;
  }

  // Immediately flush the in-memory editor buffer to disk. MarkdownView's
  // own save() is debounced (~2s); when we're about to swap the editor
  // primitive (live → CM6 or vice versa) we need a synchronous write so
  // the next read picks up freshly-typed content.
  async save(): Promise<void> {
    const v = this.getView();
    if (!v) return;
    await v.save();
  }

  // EditorHost.flush — same flush, interface name.
  async flush(): Promise<void> {
    await this.save();
  }

  async detach(): Promise<void> {
    this.generation++;
    if (this.resizeFrame !== null) this.frameWindow?.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = null;
    this.frameWindow = null;
    if (this.leaf) {
      const leaf = this.leaf;
      this.leaf = null;
      try { leaf.detach(); } catch {}
    }
    if (this.mountEl) {
      try { this.mountEl.empty(); } catch {}
      this.mountEl = null;
    }
  }

  // EditorHost.dispose — same teardown, interface name.
  async dispose(): Promise<void> {
    await this.detach();
  }

  getView(): MarkdownView | null {
    const v = this.leaf?.view;
    return v instanceof MarkdownView ? v : null;
  }

  // Read the latest editor content. Returns null if nothing's open.
  getValue(): string | null {
    const v = this.getView();
    if (!v) return null;
    try { return v.getViewData(); } catch { return null; }
  }

  isOpen(): boolean {
    return this.getView() != null;
  }

  hasOpen(): boolean {
    return this.isOpen();
  }

  focus(): void {
    try { this.getView()?.editor?.focus(); } catch {}
  }
}
