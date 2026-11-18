import type CanvasMdSideEditorPlugin from '../main';
import type { CanvasNode, CanvasLikeView } from '../types';
import type { ViewMode } from '../view-mode';
import type { HeadlineController } from '../canvas/headline-controller';
import { CanvasInteraction } from '../canvas/interaction';
import { EditorSession } from './editor-session';

// Each workspace window serializes its own opens, saves and leaf switches.
export class WindowEditor {
  readonly session: EditorSession;
  readonly interaction: CanvasInteraction;
  canvasWork: Promise<void> = Promise.resolve();
  private pendingOpen: { view: CanvasLikeView; id: string; file?: string; mode: ViewMode; promise: Promise<void> } | null = null;
  private lastOpened: { view: CanvasLikeView; id: string; file?: string; mode: ViewMode } | null = null;
  private openRequest = 0;
  private disposed = false;

  constructor(private plugin: CanvasMdSideEditorPlugin, private headline: HeadlineController) {
    this.session = new EditorSession({
      app: plugin.app,
      plugin,
      getSettings: () => plugin.settings,
      persistSettings: (s) => plugin.saveData(s),
      onCycleViewMode: () => plugin.cycleViewMode(),
    });
    this.interaction = new CanvasInteraction(plugin.app, {
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
  }

  refresh(view: CanvasLikeView | null): Promise<void> {
    return this.enqueueCanvasWork(async () => {
      if (view) return this.attachToCanvas(view);
      const previous = this.session.boundView;
      if (!previous || !(await this.session.saveStable(previous)) || this.disposed) return;
      this.interaction.detach();
      this.session.teardown();
      this.session.boundView = null;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.openRequest++;
    this.interaction.detach();
    const previous = this.session.boundView;
    const save = previous ? this.session.save(previous) : undefined;
    void save?.catch(error => console.error('CanvasMdSideEditor: final save failed', error));
    this.session.teardown(save);
    this.session.boundView = null;
  }

  async attachToCanvas(view: CanvasLikeView) {
    if (this.disposed) return;
    if (this.session.boundView === view && (!this.session.panel || this.session.panel.parentElement === view.containerEl)) return;
    const container: HTMLElement | undefined = view?.containerEl;
    const panel = this.session.panel;
    const stale = !!panel && (!panel.isConnected || (!!container && panel.parentElement !== container));
    if (stale) {
      const prev = this.session.boundView;
      if (prev) {
        if (!(await this.session.saveStable(prev))) return;
      }
      if (this.disposed) return;
      this.session.teardown();
    }
    if (this.disposed) return;
    this.interaction.detach();
    this.session.boundView = view;
    this.interaction.attach(view);
  }

  private enqueueCanvasWork(work: () => Promise<void>): Promise<void> {
    const next = this.canvasWork.then(async () => { if (!this.disposed) await work(); });
    this.canvasWork = next.catch(() => {});
    return next;
  }

  openCanvasNode(view: CanvasLikeView, node: CanvasNode): Promise<void> {
    const pending = this.pendingOpen;
    if (pending?.view === view && pending.id === node.id && pending.file === node.file && pending.mode === this.plugin.settings.viewMode) return pending.promise;
    const request = ++this.openRequest;
    const mode = this.plugin.settings.viewMode;
    const promise = this.enqueueCanvasWork(async () => {
      if (request !== this.openRequest) return;
      if (this.session.boundView === view && this.session.openNodeId === node.id
        && this.lastOpened?.file === node.file && this.lastOpened?.mode === this.plugin.settings.viewMode && this.session.panel?.classList.contains('open')) return;
      const previous = this.session.boundView;
      if (previous === view) await this.session.save(previous);
      if (!(await this.headline.waitForNativeSave(view, node))) return;
      if (request !== this.openRequest || this.disposed) return;
      await this.attachToCanvas(view);
      if (request !== this.openRequest || this.disposed || this.session.boundView !== view) return;
      if (!(await this.headline.waitForNativeSave(view, node))) return;
      if (request !== this.openRequest || this.disposed) return;
      const leaf = this.plugin.app.workspace.getLeavesOfType?.('canvas').find(candidate => candidate.view === view as unknown);
      if (leaf && this.plugin.app.workspace.activeLeaf !== leaf) this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
      if (request !== this.openRequest || this.disposed) return;
      await this.session.open(view, node);
      this.lastOpened = { view, id: node.id, file: node.file, mode };
    });
    this.pendingOpen = { view, id: node.id, file: node.file, mode, promise };
    void promise.finally(() => { if (this.pendingOpen?.promise === promise) this.pendingOpen = null; }).catch(() => {});
    return promise;
  }
}
