import { Component, MarkdownRenderer, type App, type Plugin } from 'obsidian';
import type { EditorView } from '@codemirror/view';

type RenderRequest = { text: string; container: HTMLElement; sourcePath: string; generation: number };

export class PreviewHelper {
  private timer: number | null = null;
  private timerWindow: Window | null = null;
  private sourcePath = '';
  private container: HTMLElement | null = null;
  private generation = 0;
  private renderInFlight = false;
  private pending: RenderRequest | null = null;
  private renderComponent: Component | null = null;
  private renderingComponent: Component | null = null;

  constructor(private app: App, private plugin: Plugin) {}

  setContainer(container: HTMLElement | null): void {
    if (this.container === container) return;
    this.clearTimer();
    this.generation++;
    this.pending = null;
    this.container = container;
    // A render may still register children until its promise settles. In that
    // case its owner is removed below, after the render has finished.
    if (this.renderComponent && this.renderComponent !== this.renderingComponent) {
      this.releaseRender(this.renderComponent);
    }
  }

  setSourcePath(path: string): void {
    const next = path || '';
    if (next === this.sourcePath) return;
    this.clearTimer();
    this.generation++;
    this.pending = null;
    this.sourcePath = next;
  }

  clearTimer(): void {
    if (this.timer !== null) this.timerWindow?.clearTimeout(this.timer);
    this.timer = null;
    this.timerWindow = null;
  }

  private schedule(getText: () => string, delayMs: number): void {
    const container = this.container;
    if (!container) return;
    this.clearTimer();
    const generation = this.generation;
    const win = container.ownerDocument.defaultView ?? window;
    this.timerWindow = win;
    this.timer = win.setTimeout(() => {
      this.timer = null;
      this.timerWindow = null;
      if (this.generation === generation && this.container === container) void this.renderText(getText());
    }, Math.max(16, delayMs ?? 50));
  }

  scheduleFromEditor(cmView: EditorView | null, delayMs: number): void {
    if (cmView) this.schedule(() => cmView.state.doc.toString(), delayMs);
  }

  scheduleFromText(getText: () => string, delayMs: number): void {
    this.schedule(getText, delayMs);
  }

  async renderText(text: string): Promise<void> {
    if (!this.container) return;
    this.pending = { text, container: this.container, sourcePath: this.sourcePath, generation: this.generation };
    if (this.renderInFlight) return;

    this.renderInFlight = true;
    try {
      while (this.pending) {
        const request: RenderRequest = this.pending;
        this.pending = null;
        if (request.generation !== this.generation || request.container !== this.container) continue;
        if (this.renderComponent) this.releaseRender(this.renderComponent);
        const component = this.plugin.addChild(new Component());
        this.renderComponent = component;
        this.renderingComponent = component;
        request.container.replaceChildren();
        try {
          await MarkdownRenderer.render(this.app, request.text, request.container, request.sourcePath, component);
        } catch (error) {
          console.error('CanvasMdSideEditor: renderPreview failed', error);
        } finally {
          this.renderingComponent = null;
          if (request.generation !== this.generation || request.container !== this.container) {
            this.releaseRender(component);
          }
        }
      }
    } finally {
      this.renderInFlight = false;
    }
  }

  private releaseRender(component: Component): void {
    this.plugin.removeChild(component);
    if (this.renderComponent === component) this.renderComponent = null;
  }

  syncScrollFromEditor(cmView: EditorView | null): void {
    if (!cmView || !this.container) return;
    this.container.scrollTop = cmView.scrollDOM.scrollTop;
  }
}
