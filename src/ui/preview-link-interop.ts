import type { App, Plugin } from 'obsidian';

export interface AttachPreviewLinkInteropOptions {
  app: App;
  plugin: Plugin;
  container: HTMLElement;
  getSourcePath: () => string;
  hoverSource?: string;
}

const LINK_SELECTOR = 'a.internal-link, a.markdown-embed-link';
const attached = new WeakMap<HTMLElement, () => void>();

function getLinkText(a: HTMLAnchorElement): string {
  return a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
}

function paneModeFromEvent(e: MouseEvent): 'tab' | 'split' {
  return e.shiftKey ? 'split' : 'tab';
}

export function attachPreviewLinkInterop(opts: AttachPreviewLinkInteropOptions): () => void {
  const { app, plugin, container, getSourcePath, hoverSource } = opts;

  const previous = attached.get(container);
  if (previous) return previous;

  const source = hoverSource ?? 'canvas-markdown-side-editor';

  const onMouseOver = (e: MouseEvent) => {
    try {
      const a = (e.target as Element | null)?.closest(LINK_SELECTOR) as HTMLAnchorElement | null;
      if (!a) return;
      const linktext = getLinkText(a);
      if (!linktext) return;
      app.workspace.trigger('hover-link', {
        event: e,
        source,
        hoverParent: plugin,
        targetEl: a,
        linktext,
        sourcePath: getSourcePath(),
      });
    } catch (err) {
      try { console.error('CanvasMdSideEditor: hover-link interop failed', err); } catch {}
    }
  };

  const onClick = (e: MouseEvent) => {
    try {
      const a = (e.target as Element | null)?.closest(LINK_SELECTOR) as HTMLAnchorElement | null;
      if (!a) return;
      const linktext = getLinkText(a);
      if (!linktext) return;
      e.preventDefault();
      void app.workspace.openLinkText(linktext, getSourcePath(), paneModeFromEvent(e))
        .catch(err => console.error('CanvasMdSideEditor: link click interop failed', err));
    } catch (err) {
      try { console.error('CanvasMdSideEditor: link click interop failed', err); } catch {}
    }
  };

  const onAuxClick = (e: MouseEvent) => {
    try {
      if (e.button !== 1) return;
      const a = (e.target as Element | null)?.closest(LINK_SELECTOR) as HTMLAnchorElement | null;
      if (!a) return;
      const linktext = getLinkText(a);
      if (!linktext) return;
      e.preventDefault();
      void app.workspace.openLinkText(linktext, getSourcePath(), 'tab')
        .catch(err => console.error('CanvasMdSideEditor: link auxclick interop failed', err));
    } catch (err) {
      try { console.error('CanvasMdSideEditor: link auxclick interop failed', err); } catch {}
    }
  };
  container.addEventListener('mouseover', onMouseOver);
  container.addEventListener('click', onClick);
  container.addEventListener('auxclick', onAuxClick);
  const detach = () => {
    container.removeEventListener('mouseover', onMouseOver);
    container.removeEventListener('click', onClick);
    container.removeEventListener('auxclick', onAuxClick);
    if (attached.get(container) === detach) attached.delete(container);
  };
  attached.set(container, detach);
  return detach;
}
