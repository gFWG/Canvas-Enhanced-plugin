// CanvasInteraction — everything about being attached to a Canvas view:
//   - wiring pointer/focus/keyboard listeners onto the canvas DOM
//   - single-click selection and double-click/native editing coordination
//   - patching Canvas's zoomToSelection so the panel saves & closes first
//   - closing the panel when Canvas's own inline editor takes focus
//
// Raw events are translated into four high-level callbacks on the delegate
// (EditorSession in practice): openNode / save / saveAndClose, plus a
// panelEl getter used to ignore events originating inside the side panel.
//
// Unlike the previous implementation, listeners are registered and removed
// by this class itself (not via the plugin's registerDomEvent), so repeated
// attach() calls on the same view no longer accumulate duplicate handlers.
import { Notice, type App } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type { CanvasNode, CanvasLikeView, CanvasLike } from '../types';
import { findNodeIdAtPoint, hitTestNodeAt } from './hit-test';

const MOVE_TOLERANCE_PX = 6; // distance threshold to treat as drag
const LONG_PRESS_MS = 350;   // duration threshold to treat as long-press

export interface InteractionDelegate {
  getPanelEl(): HTMLElement | null;
  // Id of the node currently open in the side panel (null when closed).
  getOpenNodeId(): string | null;
  // Headline mode leaves excluded cards' native editor gestures intact.
  allowNativeEditing?(view: CanvasLikeView, target: HTMLElement): boolean;
  requestMarkdownEdit?(view: CanvasLikeView, target: HTMLElement): boolean;
  save(view: CanvasLikeView): Promise<void>;
  saveAndClose(view: CanvasLikeView): Promise<void>;
  openNode(view: CanvasLikeView, node: CanvasNode): Promise<void>;
}

// The workspace's currently active Canvas view, or null.
export function getActiveCanvasView(app: App): CanvasLikeView | null {
  const leaf: WorkspaceLeaf | null = app.workspace.activeLeaf ?? null;
  if (!leaf) return null;
  const vUnknown = leaf.view as unknown;
  const getType = (vUnknown as { getViewType?: () => string }).getViewType?.();
  if (getType === 'canvas') {
    return vUnknown as CanvasLikeView;
  }
  return null;
}

export function isCanvasView(view: unknown): boolean {
  const getType = (view as { getViewType?: () => string })?.getViewType?.();
  return getType === 'canvas';
}

export class CanvasInteraction {
  private app: App;
  private delegate: InteractionDelegate;

  private detachFns: Array<() => void> = [];

  // Zoom-to-selection integration
  private zoomingToSelection: boolean = false;

  // Single-click detection state
  private pointerDownTime: number = 0;
  private pointerDownX: number = 0;
  private pointerDownY: number = 0;
  private pointerDragging: boolean = false;
  // Listeners sit on several nested elements (container / contentEl /
  // wrapper), so one physical event bubbles through multiple registrations.
  // Dedupe by event object identity so each gesture is handled once.
  private lastPointerDownEvent: PointerEvent | null = null;
  private lastPointerUpEvent: PointerEvent | null = null;

  constructor(app: App, delegate: InteractionDelegate) {
    this.app = app;
    this.delegate = delegate;
  }

  private get panelEl(): HTMLElement | null {
    return this.delegate.getPanelEl();
  }

  attach(view: CanvasLikeView): void {
    this.detach();
    const container: HTMLElement | undefined = view?.containerEl;
    if (!container) return;
    const contentEl: HTMLElement | undefined = view?.contentEl;
    const innerEl: HTMLElement | null = container.querySelector(
      '.canvas-container, .canvas-wrapper, .canvas-viewport'
    );
    const targets: HTMLElement[] = [container];
    if (contentEl && contentEl !== container) targets.push(contentEl);
    if (innerEl && !targets.includes(innerEl)) targets.push(innerEl);
    const canvasEls = Array.from(container.querySelectorAll('canvas')) as HTMLElement[];
    for (const c of canvasEls) {
      if (!targets.includes(c)) targets.push(c);
    }
    const canvasObj: CanvasLike | undefined = view.canvas as CanvasLike | undefined;
    const originalZoom = canvasObj?.zoomToSelection;
    if (canvasObj && typeof originalZoom === 'function') {
      const previous = Object.getOwnPropertyDescriptor(canvasObj, 'zoomToSelection');
      const timerWindow = container.ownerDocument.defaultView ?? window;
      let active = true;
      let zoomTimer: number | null = null;
      const interaction = this;
      const wrapper = async function(...args: unknown[]) {
        if (!active) return Reflect.apply(originalZoom, canvasObj, args);
        interaction.zoomingToSelection = true;
        try {
          if (interaction.panelEl) await interaction.delegate.saveAndClose(view);
        } catch (error) {
          interaction.reportSaveError(error);
        }
        try {
          return await Reflect.apply(originalZoom, canvasObj, args);
        } finally {
          if (active) {
            if (zoomTimer !== null) timerWindow.clearTimeout(zoomTimer);
            zoomTimer = timerWindow.setTimeout(() => { interaction.zoomingToSelection = false; }, 200);
          }
        }
      };
      try {
        Object.defineProperty(canvasObj, 'zoomToSelection', { value: wrapper, configurable: true, writable: true });
        this.detachFns.push(() => {
          active = false;
          if (zoomTimer !== null) timerWindow.clearTimeout(zoomTimer);
          if (canvasObj.zoomToSelection === wrapper) {
            if (previous) Object.defineProperty(canvasObj, 'zoomToSelection', previous);
            else delete canvasObj.zoomToSelection;
          }
          interaction.zoomingToSelection = false;
        });
      } catch {
        // Unsupported Canvas object: leave its native zoom behavior intact.
      }
    }

    // Use capture on pointerdown to catch background clicks before Canvas swallows them
    const onPointerDown = async (evt: PointerEvent) => {
      try {
      if (evt === this.lastPointerDownEvent) return;
      this.lastPointerDownEvent = evt;
      const target = evt.target as HTMLElement | null;
      if (!target) return;
      // Ignore clicks inside the panel
      const panel = this.panelEl;
      if (panel && panel.contains(target)) return;
      // record pointer down state for single-click detection
      this.pointerDownTime = Date.now();
      this.pointerDownX = evt.clientX;
      this.pointerDownY = evt.clientY;
      this.pointerDragging = false;
      const cardEl = target.closest(
        '.canvas-node, .canvas-card, [data-node-id], [data-id]'
      ) as HTMLElement | null;
      const domId = cardEl?.getAttribute('data-node-id') || cardEl?.getAttribute('data-id') || null;
      const idByPoint = findNodeIdAtPoint(evt.clientX, evt.clientY, container.ownerDocument);
      let hitId: string | null = null;
      if (!domId && !idByPoint) {
        try { hitId = await hitTestNodeAt(this.app, view, evt.clientX, evt.clientY); } catch {}
      }
      const nodeId = domId ?? idByPoint ?? hitId;
      // Only save if panel is open
      if (this.panelEl) {
        // Clicking another card should also save current, but avoid saving if clicking the same card
        if (nodeId) {
          if (this.currentOpenNodeId() && this.currentOpenNodeId() !== nodeId) {
            await this.delegate.save(view);
          }
        } else {
          // Background pointerdown: pre-save edits
          await this.delegate.save(view);
        }
      }
      // Don't close here, allow click handler to reopen if it's a card
      } catch (error) {
        this.pointerDragging = true;
        this.reportSaveError(error);
      }
    };

    // Detect dragging by measuring movement beyond a tolerance
    const onPointerMove = (evt: PointerEvent) => {
      if (!this.pointerDownTime) return;
      const dx = Math.abs(evt.clientX - this.pointerDownX);
      const dy = Math.abs(evt.clientY - this.pointerDownY);
      if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) {
        this.pointerDragging = true;
      }
    };

    // Finalize on pointerup for better alignment with Canvas selection update timing
    const onPointerUp = async (evt: PointerEvent) => {
      try {
      if (evt === this.lastPointerUpEvent) return;
      this.lastPointerUpEvent = evt;
      if (!isCanvasView(view)) return;
      const target = evt.target as HTMLElement | null;
      if (!target) return;
      const panel = this.panelEl;
      if (panel && panel.contains(target)) return;
      // Do not open editor while zoom-to-selection in progress
      if (this.zoomingToSelection) {
        this.pointerDownTime = 0; this.pointerDragging = false;
        return;
      }

      // qualify as a true single click only if primary button, short press, and no drag
      const isPrimaryButton = evt.button === 0;
      const dt = this.pointerDownTime ? (Date.now() - this.pointerDownTime) : 0;
      const dx = Math.abs(evt.clientX - this.pointerDownX);
      const dy = Math.abs(evt.clientY - this.pointerDownY);
      const moved = dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX;
      const isLongPress = dt >= LONG_PRESS_MS;

      const qualifiesSingleClick = isPrimaryButton && !this.pointerDragging && !moved && !isLongPress;

      // A click selects a Canvas card; editing starts only through the native
      // double-click, menu, or keyboard edit gesture. Close a previous side
      // editor after saving rather than opening the clicked card here.
      if (qualifiesSingleClick && panel?.classList.contains('open')) {
        await this.delegate.saveAndClose(view);
      }
      // clear states on non-qualifying interactions without acting
      this.pointerDownTime = 0; this.pointerDragging = false;
      } catch (error) { this.reportSaveError(error); }
    };

    // Suppress Canvas default double-click zoom when our panel is active
    const onDblClick = (evt: MouseEvent) => {
      try {
        if (!isCanvasView(view)) return;
        const target = evt.target as HTMLElement | null;
        if (!target) return;
        // Allow dblclicks inside panel (e.g., selecting text within editor/preview)
        const panel = this.panelEl;
        if (panel && panel.contains(target)) return;
        if (evt.button !== 0) return;
        if (this.delegate.requestMarkdownEdit?.(view, target)) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          evt.stopPropagation();
          return;
        }
        if (this.delegate.allowNativeEditing?.(view, target)) return;
        // Only suppress when our editor panel is open/active
        const panelOpen = !!panel && panel.classList.contains('open');
        if (!panelOpen) return;
        // Prevent Canvas from handling zoom-to-selection or opening native editor
        evt.preventDefault();
        evt.stopImmediatePropagation();
        evt.stopPropagation();
      } catch {}
    };

    // Close side panel immediately when Canvas' own inline editor gets focus or typing begins
    const onFocusIn = async (evt: FocusEvent) => {
      try {
        const target = evt.target as HTMLElement | null;
        if (!target) return;
        // Ignore focus inside our side panel
        const panel = this.panelEl;
        if (panel && panel.contains(target)) return;
        if (this.isCanvasInlineEditTarget(target)) {
          if (this.panelEl) await this.delegate.saveAndClose(view);
        }
      } catch (error) { this.reportSaveError(error); }
    };

    const onKeyDown = async (evt: KeyboardEvent) => {
      try {
        // In case focusin didn't fire for some reason, detect typing within Canvas inline editor
        const target = evt.target as HTMLElement | null;
        if (!target) return;
        const panel = this.panelEl;
        if (panel && panel.contains(target)) return;
        if (this.isCanvasInlineEditTarget(target)) {
          if (this.panelEl) await this.delegate.saveAndClose(view);
        }
      } catch (error) { this.reportSaveError(error); }
    };

    // Use bubbling phase for click so Canvas can update selection first
    for (const t of targets) {
      // click listener removed to avoid false triggers from long-press/drag
      this.listen(t, 'pointerdown', onPointerDown, { capture: true });
      this.listen(t, 'pointermove', onPointerMove);
      this.listen(t, 'pointerup', onPointerUp);
      this.listen(t, 'dblclick', onDblClick, { capture: true });
      this.listen(t, 'focusin', onFocusIn, { capture: true });
      this.listen(t, 'keydown', onKeyDown, { capture: true });
    }
  }

  detach(): void {
    while (this.detachFns.length) {
      const off = this.detachFns.pop();
      try { off && off(); } catch {}
    }
    this.zoomingToSelection = false;
  }

  private listen<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const listener = handler as unknown as EventListener;
    el.addEventListener(type, listener, options);
    this.detachFns.push(() => {
      try { el.removeEventListener(type, listener, options); } catch {}
    });
  }

  private reportSaveError(error: unknown): void {
    console.error('CanvasMdSideEditor: could not save the side editor', error);
    new Notice('Could not save the note. Your edits remain in the side panel.');
  }

  private currentOpenNodeId(): string | null {
    return this.delegate.getOpenNodeId();
  }

  private isCanvasInlineEditTarget(el: HTMLElement | null): boolean {
    try {
      if (!el) return false;
      // Exclude our side panel
      const panel = this.panelEl;
      if (panel && panel.contains(el)) return false;
      // Must be within a Canvas card element
      const card = el.closest('.canvas-node, .canvas-card, [data-node-id], [data-id]') as HTMLElement | null;
      if (!card) return false;
      // Typical editable areas inside Canvas cards
      if (el.closest('[contenteditable="true"], textarea, input[type="text"], .cm-editor')) return true;
      // Some themes/plugins toggle editing classes on the card
      const cls = (card.className || '').toLowerCase();
      if (cls.includes('editing') || cls.includes('is-editing')) return true;
      return false;
    } catch {
      return false;
    }
  }
}
