// Canvas runtime integration for headline mode. Canvas node objects are not a
// public Obsidian API, so all access and reversible patches are kept here.
import { Notice, resolveSubpath, TFile, type App } from 'obsidian';
import type { CanvasMdSideEditorSettings } from '../settings';
import type { CanvasLikeView, CanvasNode } from '../types';
import { clearHeadlineCard, refreshHeadlineCard, type HeadlinePreviewRenderer } from '../features/headline-mode';

type RuntimeNode = {
  nodeEl: HTMLElement;
  getData(): CanvasNode;
  startEditing?: (...args: unknown[]) => unknown;
  isEditing?: boolean;
  blur?: () => void;
  child?: { savePromise?: Promise<unknown> | null; previewMode?: { renderer?: HeadlinePreviewRenderer } };
};

type RuntimeCanvas = {
  nodes: Map<string, RuntimeNode>;
  addNode: (...args: unknown[]) => unknown;
  removeNode: (...args: unknown[]) => unknown;
  readonly?: boolean;
};

type ViewState = {
  view: CanvasLikeView;
  canvas: RuntimeCanvas;
  nodes: Map<RuntimeNode, () => void>;
  unpatch: Array<() => void>;
  win: Window;
  observer: MutationObserver;
  timer: number | null;
  active: boolean;
};

function isMarkdownNote(data: CanvasNode | null): data is CanvasNode {
  return !!data && data.type === 'file' && typeof data.file === 'string' && /\.md$/i.test(data.file);
}

function isEditableCard(data: CanvasNode | null): boolean {
  return !!data && (data.type === 'text' || isMarkdownNote(data));
}

function nodeData(node: RuntimeNode): CanvasNode | null {
  try {
    const data: unknown = node.getData();
    return data && typeof data === 'object' && typeof (data as CanvasNode).id === 'string'
      ? data as CanvasNode : null;
  } catch {
    return null;
  }
}

// Deactivation makes a wrapper harmless even if another plugin has since
// wrapped it. Restore a property only while our wrapper is still installed.
function wrapMethod(
  object: object,
  key: string,
  intercept: (next: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]) => unknown,
): (() => void) | null {
  const target = object as Record<string, unknown>;
  const next = target[key];
  if (typeof next !== 'function') return null;
  const previous = Object.getOwnPropertyDescriptor(object, key);
  let handler: typeof intercept | null = intercept;
  const wrapper = function(this: unknown, ...args: unknown[]) {
    return handler ? handler(next as (...args: unknown[]) => unknown, this, args)
      : Reflect.apply(next as (...args: unknown[]) => unknown, this, args);
  };
  try {
    Object.defineProperty(object, key, { value: wrapper, configurable: true, writable: true });
  } catch {
    return null;
  }
  return () => {
    handler = null;
    if (target[key] !== wrapper) return;
    if (previous) Object.defineProperty(object, key, previous);
    else delete target[key];
  };
}

export class HeadlineController {
  private readonly states = new Map<CanvasLikeView, ViewState>();
  private readonly warned = new WeakSet<object>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => CanvasMdSideEditorSettings,
    private readonly openNode: (view: CanvasLikeView, node: CanvasNode) => Promise<void>,
  ) {}

  update(views: CanvasLikeView[]): void {
    const wanted = new Set(views);
    for (const [view, state] of this.states) {
      if (!wanted.has(view) || view.canvas !== state.canvas || view.containerEl.ownerDocument.defaultView !== state.win) this.removeView(state);
    }
    for (const view of wanted) {
      if (!this.states.has(view)) this.addView(view);
      const state = this.states.get(view);
      if (state) this.schedule(state);
    }
  }

  dispose(): void {
    for (const state of this.states.values()) this.removeView(state);
  }

  // Headline metadata and titles can sit outside Obsidian's native Markdown
  // click target. Route their double-clicks through the same edit guard.
  requestMarkdownEdit(view: CanvasLikeView, target: HTMLElement): boolean {
    const state = this.states.get(view);
    if (!state?.active || state.canvas.readonly) return false;
    if (target.closest('a, button, input, textarea, select, [contenteditable="true"], .cm-editor, .interactive-child, .collapse-indicator')) return false;
    for (const node of state.nodes.keys()) {
      if (target.closest('.canvas-node') === node.nodeEl
        && isMarkdownNote(nodeData(node)) && typeof node.startEditing === 'function') {
        node.startEditing();
        return true;
      }
    }
    return false;
  }

  // The panel can also be opened by the existing pointer handler, bypassing
  // startEditing. Both paths must wait for a native editor's final file save.
  async waitForNativeSave(view: CanvasLikeView, requested: CanvasNode): Promise<boolean> {
    const state = this.states.get(view);
    if (!state?.active) return true;
    const expected = { id: requested.id, file: requested.file, subpath: requested.subpath };
    for (const node of state.nodes.keys()) {
      const data = nodeData(node);
      if (data?.id === expected.id) {
        const matches = () => {
          const current = nodeData(node);
          return state.active && state.canvas.nodes.get(expected.id) === node
            && current?.id === expected.id && current.file === expected.file
            && current.subpath === expected.subpath;
        };
        if (!matches()) return false;
        await this.waitForNodeSave(node);
        return matches();
      }
    }
    return false;
  }

  private warn(view: CanvasLikeView): void {
    if (this.warned.has(view)) return;
    this.warned.add(view);
    new Notice('Canvas card editing is unavailable in this Canvas on this Obsidian version.');
  }

  private addView(view: CanvasLikeView): void {
    const canvas = view.canvas as unknown as RuntimeCanvas | undefined;
    if (!view.containerEl || !canvas || !canvas.nodes || typeof canvas.nodes.values !== 'function'
      || typeof canvas.addNode !== 'function' || typeof canvas.removeNode !== 'function') {
      this.warn(view);
      return;
    }
    const win = view.containerEl.ownerDocument.defaultView ?? window;
    const observer = new win.MutationObserver(() => {
      const state = this.states.get(view);
      if (state) this.schedule(state);
    });
    const state: ViewState = { view, canvas, win, nodes: new Map(), unpatch: [], observer, timer: null, active: true };
    this.states.set(view, state);

    const add = wrapMethod(canvas, 'addNode', (next, receiver, args) => {
      const node = args[0] as RuntimeNode;
      if (!this.installNode(state, node)) this.unsupported(state);
      try {
        return Reflect.apply(next, receiver, args);
      } finally {
        if (state.active) this.schedule(state);
      }
    });
    const remove = wrapMethod(canvas, 'removeNode', (next, receiver, args) => {
      const node = args[0] as RuntimeNode;
      const result = Reflect.apply(next, receiver, args);
      this.removeNode(state, node);
      this.schedule(state);
      return result;
    });
    if (!add || !remove) {
      add?.();
      remove?.();
      this.unsupported(state);
      return;
    }
    state.unpatch.push(add, remove);
    for (const node of canvas.nodes.values()) {
      if (!this.installNode(state, node)) {
        this.unsupported(state);
        return;
      }
    }
    this.observe(state);
  }

  private installNode(state: ViewState, node: RuntimeNode): boolean {
    if (!node || typeof node.getData !== 'function' || !node.nodeEl || node.nodeEl.nodeType !== 1) return false;
    const data = nodeData(node);
    if (!data) return false;
    // Obsidian's native blur commits the embedded editor before returning to
    // preview. Never remove its DOM or force the editing flag ourselves.
    if (isMarkdownNote(data) && node.isEditing) {
      if (typeof node.blur !== 'function') return false;
      try { node.blur(); } catch { return false; }
      if (node.isEditing) return false;
    }
    if (state.nodes.has(node)) return true;
    const preventSingleClick = (event: MouseEvent) => {
      if (!state.active || node.isEditing || event.defaultPrevented || event.button !== 0 || event.detail !== 1
        || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || !isEditableCard(nodeData(node))) return;
      const target = event.target as Element | null;
      if (!target || target.nodeType !== 1 || target.closest('.canvas-node') !== node.nodeEl) return;
      if (target.closest('a, button, input, textarea, select, [contenteditable="true"], .cm-editor, .interactive-child, .collapse-indicator')) return;
      // Obsidian checks defaultPrevented before scheduling its single-click
      // inline editor. Selection uses pointer events and still propagates.
      event.preventDefault();
    };
    node.nodeEl.addEventListener('click', preventSingleClick, true);
    const removeClick = () => node.nodeEl.removeEventListener('click', preventSingleClick, true);
    if (typeof node.startEditing !== 'function') {
      // Non-editable images, links, and groups do not need a guard.
      if (isMarkdownNote(data)) { removeClick(); return false; }
      state.nodes.set(node, removeClick);
      return true;
    }
    const remove = wrapMethod(node, 'startEditing', (next, receiver, args) => {
      const current = nodeData(node);
      if (state.active && !state.canvas.readonly && isMarkdownNote(current)) {
        void this.openAfterNativeSave(state, node, { ...current });
        return undefined;
      }
      return Reflect.apply(next, receiver, args);
    });
    if (!remove) { removeClick(); return false; }
    state.nodes.set(node, () => { removeClick(); remove(); });
    return true;
  }

  private async openAfterNativeSave(state: ViewState, node: RuntimeNode, requested: CanvasNode): Promise<void> {
    try {
      // Native blur commits an active file embed asynchronously. Wait for
      // its in-flight writes before the side editor reads the whole file.
      if (node.child?.savePromise) await this.waitForNodeSave(node);
      const current = nodeData(node);
      if (!state.active || !isMarkdownNote(current)
        || current.id !== requested.id || current.file !== requested.file || current.subpath !== requested.subpath) return;
      await this.openNode(state.view, current);
    } catch (error) {
      console.error('CanvasMdSideEditor: failed to open side editor', error);
      new Notice('Could not open the side editor after saving the Canvas note.');
    }
  }

  private async waitForNodeSave(node: RuntimeNode): Promise<void> {
    const child = node.child;
    while (child?.savePromise) {
      await child.savePromise;
      // Allow a queued native save, if any, to replace savePromise.
      await Promise.resolve();
    }
  }

  private removeNode(state: ViewState, node: RuntimeNode): void {
    const unpatch = state.nodes.get(node);
    if (!unpatch) return;
    unpatch();
    state.nodes.delete(node);
    clearHeadlineCard(node.nodeEl);
  }

  private unsupported(state: ViewState): void {
    this.warn(state.view);
    this.removeView(state);
  }

  private removeView(state: ViewState): void {
    if (!state.active) return;
    state.active = false;
    state.observer.disconnect();
    if (state.timer !== null) state.win.clearTimeout(state.timer);
    state.timer = null;
    for (const node of [...state.nodes.keys()]) this.removeNode(state, node);
    for (const unpatch of state.unpatch.splice(0)) unpatch();
    this.states.delete(state.view);
  }

  private observe(state: ViewState): void {
    if (!this.getSettings().headlineMode) return;
    state.observer.observe(state.view.containerEl, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['data-callout'],
    });
  }

  private schedule(state: ViewState): void {
    if (!state.active || state.timer !== null) return;
    state.timer = state.win.setTimeout(() => {
      state.timer = null;
      if (!state.active) return;
      // Our decoration itself changes DOM; disconnect while reconciling so it
      // cannot feed back into the observer. JavaScript remains synchronous.
      state.observer.disconnect();
      try {
        const currentNodes = new Set(state.canvas.nodes.values());
        for (const node of state.nodes.keys()) {
          if (!currentNodes.has(node)) this.removeNode(state, node);
        }
        for (const node of currentNodes) {
          if (!this.installNode(state, node)) {
            this.unsupported(state);
            return;
          }
          const data = nodeData(node);
          if (!this.getSettings().headlineMode || !isMarkdownNote(data)) {
            clearHeadlineCard(node.nodeEl);
            continue;
          }
          if (!data.subpath) {
            refreshHeadlineCard(node.nodeEl, { kind: 'outline', renderer: node.child?.previewMode?.renderer });
          } else if (data.subpath.startsWith('#^')) {
            clearHeadlineCard(node.nodeEl);
          } else {
            const heading = this.resolveHeading(data);
            if (heading) refreshHeadlineCard(node.nodeEl, { kind: 'heading', heading });
            else clearHeadlineCard(node.nodeEl);
          }
        }
      } finally {
        if (state.active) this.observe(state);
      }
    }, 0);
  }

  private resolveHeading(data: CanvasNode): { heading: string; level: number } | null {
    try {
      if (!data.file || !data.subpath || typeof resolveSubpath !== 'function') return null;
      const file = this.app.vault.getAbstractFileByPath(data.file);
      if (!(file instanceof TFile)) return null;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) return null;
      const result = resolveSubpath(cache, data.subpath);
      if (result?.type !== 'heading') return null;
      return { heading: result.current.heading, level: result.current.level };
    } catch {
      return null;
    }
  }
}
