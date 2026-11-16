// Headline presentation works on Obsidian's rendered Markdown. The controller
// supplies a card and its live Canvas context; this module never changes source.
import { DEFAULT_SETTINGS, HEADLINE_SIZE_LIMITS, type CanvasMdSideEditorSettings } from '../settings';

export interface HeadlineCardContext {
  kind: 'native' | 'outline' | 'heading';
  heading?: { heading: string; level: number };
  renderer?: HeadlinePreviewRenderer;
}

// Obsidian virtualizes Markdown preview sections by detaching off-screen
// elements. A full-file outline must retain those sections in its native
// scroller, otherwise its DOM contains only the headings near the viewport.
export interface HeadlinePreviewRenderer {
  previewEl: HTMLElement;
  sizerEl: HTMLElement;
  pusherEl: HTMLElement;
  sections: Array<{ el: HTMLElement; resetCompute?: () => void }>;
  updateVirtualDisplay: (...args: unknown[]) => unknown;
  queueRender?: () => void;
}

const BODY_CLASS = 'cmside-headline-mode';
const CARD_CLASS = 'cmside-headline-card';
const ROOT_CLASS = 'cmside-headline-root';
const TITLE_CLASS = 'cmside-headline-title';
const NOTE_CLASS = 'cmside-headline-note';
const PATH_CLASS = 'cmside-headline-path';
const KEEP_CLASS = 'cmside-headline-keep';
const META_CLASS = 'cmside-hl-meta';
const CLIPPED_CLASS = 'cmside-headline-subtitle-clipped';
const SUBTITLE_LINES_VAR = '--cmside-subtitle-lines';

interface CardState {
  marks: Map<Element, Set<string>>;
  rows: Map<Element, HTMLElement>;
  orders: Map<HTMLElement, { value: string; priority: string }>;
  synthetic: HTMLElement | null;
  preview: { renderer: HeadlinePreviewRenderer; remove: () => void } | null;
}

const cards = new Map<HTMLElement, CardState>();
let clipObserver: ResizeObserver | null = null;
let clipFrame = 0;
let clipWindow: Window | null = null;

function isHTMLElement(element: Element | null): element is HTMLElement {
  const constructor = element?.ownerDocument.defaultView?.HTMLElement;
  return !!element && !!constructor && element instanceof constructor;
}

export function parseNoteTitle(rawTitle: string, calloutType = 'note'): { identifier: string; category: string } {
  const text = rawTitle.trim();
  if (!text || text.toLowerCase() === calloutType.trim().toLowerCase()) {
    return { identifier: '', category: '' };
  }
  const pipe = text.indexOf('|');
  if (pipe === -1) return { identifier: '', category: text };
  return { identifier: text.slice(0, pipe).trim(), category: text.slice(pipe + 1).trim() };
}

function isOwnedContent(element: Element, root: Element): boolean {
  for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (parent.matches('.callout, .markdown-embed, .internal-embed, .inline-title, .cmside-hl-meta')) return false;
  }
  return true;
}

interface HeadingPart { title: Element; note: Element | null }

// Select note-owned rendered headings and associate the first Note with each H1.
export function selectOutlineParts(root: Element): HeadingPart[] {
  const parts: HeadingPart[] = [];
  let h1: HeadingPart | null = null;
  for (const element of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6, .callout[data-callout="note"]'))) {
    if (!isOwnedContent(element, root)) continue;
    if (/^H[1-6]$/.test(element.tagName)) {
      const part = { title: element, note: null };
      parts.push(part);
      if (element.tagName === 'H1') h1 = part;
    } else if (h1 && !h1.note) {
      h1.note = element;
    }
  }
  return parts;
}

function selectSectionNote(root: Element, level: number): Element | null {
  for (const element of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6, .callout[data-callout="note"]'))) {
    if (!isOwnedContent(element, root)) continue;
    if (/^H[1-6]$/.test(element.tagName)) {
      if (Number(element.tagName.slice(1)) <= level) break;
    } else {
      return element;
    }
  }
  return null;
}

function addMark(marks: Map<Element, Set<string>>, element: Element, name: string): void {
  const names = marks.get(element) ?? new Set<string>();
  names.add(name);
  marks.set(element, names);
}

function markTree(marks: Map<Element, Set<string>>, element: Element): void {
  addMark(marks, element, KEEP_CLASS);
  for (const child of Array.from(element.children)) markTree(marks, child);
}

function markPath(marks: Map<Element, Set<string>>, element: Element, card: Element): void {
  for (let parent = element.parentElement; parent && parent !== card; parent = parent.parentElement) {
    addMark(marks, parent, PATH_CLASS);
  }
}

function reconcileMarks(state: CardState, desired: Map<Element, Set<string>>): void {
  for (const [element, names] of state.marks) {
    for (const name of names) if (!desired.get(element)?.has(name)) element.classList.remove(name);
  }
  for (const [element, names] of desired) {
    for (const name of names) if (!state.marks.get(element)?.has(name) || !element.classList.contains(name)) element.classList.add(name);
  }
  state.marks = desired;
}

function syncOrder(state: CardState, element: HTMLElement, order: number): void {
  if (!state.orders.has(element)) {
    state.orders.set(element, { value: element.style.getPropertyValue('order'), priority: element.style.getPropertyPriority('order') });
  }
  if (element.style.getPropertyValue('order') !== String(order) || element.style.getPropertyPriority('order') !== 'important') {
    element.style.setProperty('order', String(order), 'important');
  }
}

function restoreOrder(element: HTMLElement, previous: { value: string; priority: string }): void {
  if (previous.value) element.style.setProperty('order', previous.value, previous.priority);
  else element.style.removeProperty('order');
}

// Keep the original section boxes: Obsidian measures their offsets and uses
// the preview element itself as its scrolling surface. This mirrors the
// renderer's own non-progressive display path without changing other views.
function showAllSections(renderer: HeadlinePreviewRenderer): void {
  const { sizerEl, pusherEl, sections } = renderer;
  const children = [pusherEl, ...sections.map(section => section.el)];
  if (children.some(element => !isHTMLElement(element))) return;
  pusherEl.style.marginBottom = '0px';
  sizerEl.style.minHeight = '';
  const nativeSizer = sizerEl as HTMLElement & { setChildrenInPlace?: (elements: HTMLElement[]) => void };
  if (typeof nativeSizer.setChildrenInPlace === 'function') {
    nativeSizer.setChildrenInPlace(children);
    return;
  }
  // Fallback for tests and older DOM helpers; keep existing children in place.
  for (let index = 0; index < children.length; index++) {
    if (sizerEl.children[index] !== children[index]) sizerEl.insertBefore(children[index], sizerEl.children[index] ?? null);
  }
  while (sizerEl.children.length > children.length) sizerEl.lastElementChild?.remove();
}

function installPreview(state: CardState, renderer: HeadlinePreviewRenderer | undefined, root: HTMLElement): boolean {
  if (state.preview?.renderer !== renderer) {
    state.preview?.remove();
    state.preview = null;
  }
  if (!renderer) return !root.querySelector('.markdown-preview-pusher');
  if (renderer.previewEl !== root || !root.contains(renderer.sizerEl) || !isHTMLElement(renderer.pusherEl)
    || !Array.isArray(renderer.sections) || typeof renderer.updateVirtualDisplay !== 'function') return false;
  if (!state.preview) {
    const original = renderer.updateVirtualDisplay;
    const descriptor = Object.getOwnPropertyDescriptor(renderer, 'updateVirtualDisplay');
    let active = true;
    const wrapper = function(this: HeadlinePreviewRenderer, ...args: unknown[]) {
      if (!active) return Reflect.apply(original, this, args);
      showAllSections(this);
    };
    try {
      Object.defineProperty(renderer, 'updateVirtualDisplay', { value: wrapper, writable: true, configurable: true });
    } catch {
      return false;
    }
    state.preview = {
      renderer,
      remove: () => {
        active = false;
        try {
          if (renderer.updateVirtualDisplay === wrapper) {
            if (descriptor) Object.defineProperty(renderer, 'updateVirtualDisplay', descriptor);
            else delete (renderer as Partial<HeadlinePreviewRenderer>).updateVirtualDisplay;
          }
          // Restore the native virtual window and spacer immediately when this
          // card stops being an outline, including after another plugin wraps it.
          if (renderer.previewEl.isConnected) {
            for (const section of renderer.sections) section.resetCompute?.();
            renderer.updateVirtualDisplay();
            renderer.queueRender?.();
          }
        } catch (error) {
          console.warn('CanvasMdSideEditor: could not restore the native preview', error);
        }
      },
    };
  }
  showAllSections(renderer);
  return true;
}

function orderBox(element: HTMLElement, sizer: Element | null): HTMLElement {
  let box: HTMLElement = element;
  while (sizer && box.parentElement && box.parentElement !== sizer) {
    if (!isHTMLElement(box.parentElement)) break;
    box = box.parentElement;
  }
  return box;
}

function syncMetaRow(state: CardState, title: Element, note: Element | null): HTMLElement | null {
  let row = state.rows.get(title);
  const { identifier, category } = note
    ? parseNoteTitle(note.querySelector('.callout-title-inner')?.textContent ?? '', note.getAttribute('data-callout') ?? 'note')
    : { identifier: '', category: '' };
  if (!identifier && !category) {
    row?.remove();
    state.rows.delete(title);
    return null;
  }
  if (!row) {
    row = title.ownerDocument.createElement('div');
    row.className = `${META_CLASS} ${KEEP_CLASS}`;
    const badge = title.ownerDocument.createElement('span');
    badge.className = `cmside-hl-badge ${KEEP_CLASS}`;
    const label = title.ownerDocument.createElement('span');
    label.className = `cmside-hl-category ${KEEP_CLASS}`;
    row.append(badge, label);
    state.rows.set(title, row);
  }
  if (title.previousElementSibling !== row) title.before(row);
  const badge = row.firstElementChild as HTMLElement;
  const label = row.lastElementChild as HTMLElement;
  if (badge.textContent !== identifier) badge.textContent = identifier;
  if (badge.style.display !== (identifier ? '' : 'none')) badge.style.display = identifier ? '' : 'none';
  if (label.textContent !== category) label.textContent = category;
  if (label.style.display !== (category ? '' : 'none')) label.style.display = category ? '' : 'none';
  return row;
}

export function refreshHeadlineCard(card: HTMLElement, context: HeadlineCardContext): void {
  if (context.kind === 'native' || (context.kind === 'heading' && !context.heading)) {
    clearHeadlineCard(card);
    return;
  }
  const root = card.querySelector('.markdown-preview-view, .markdown-rendered');
  if (!isHTMLElement(root)) {
    clearHeadlineCard(card);
    return;
  }
  let state = cards.get(card);
  if (!state) {
    state = { marks: new Map(), rows: new Map(), orders: new Map(), synthetic: null, preview: null };
    cards.set(card, state);
  }
  let previousPreview: CardState['preview'] = null;
  if (context.kind === 'outline') {
    if (!installPreview(state, context.renderer, root)) {
      clearHeadlineCard(card);
      return;
    }
  } else if (state.preview) {
    previousPreview = state.preview;
    state.preview = null;
  }
  const marks = new Map<Element, Set<string>>();
  addMark(marks, card, CARD_CLASS);
  addMark(marks, card, context.kind === 'outline' ? 'cmside-headline-outline' : 'cmside-headline-heading');
  addMark(marks, root, ROOT_CLASS);
  const inlineTitle = card.querySelector('.inline-title');
  const sizer = root.querySelector('.markdown-preview-sizer');
  let parts: HeadingPart[];
  if (context.kind === 'outline') {
    if (state.synthetic) { state.synthetic.remove(); state.synthetic = null; }
    parts = selectOutlineParts(root);
    if (!parts.length) addMark(marks, root, 'cmside-headline-empty');
    // Preserve native section wrappers and the virtualizer's pusher; only
    // their non-headline contents should be hidden by the CSS rule.
    if (sizer) {
      for (const child of Array.from(sizer.children)) {
        if (child.matches('.markdown-preview-pusher')) addMark(marks, child, KEEP_CLASS);
        else if (child.tagName === 'DIV' && !child.matches('.mod-header, .mod-footer, .callout, .markdown-embed, .internal-embed, .cmside-hl-meta')) {
          addMark(marks, child, PATH_CLASS);
        }
      }
    }
  } else {
    const heading = context.heading!;
    let title = inlineTitle?.querySelector('h1, h2, h3, h4, h5, h6') ?? inlineTitle;
    if (!title) {
      if (!state.synthetic || !state.synthetic.isConnected) {
        state.synthetic = card.ownerDocument.createElement('div');
        state.synthetic.className = 'cmside-headline-synthetic';
        const sizer = root.querySelector('.markdown-preview-sizer') ?? root;
        sizer.prepend(state.synthetic);
      }
      if (state.synthetic.textContent !== heading.heading) state.synthetic.textContent = heading.heading;
      title = state.synthetic;
    } else if (state.synthetic) {
      state.synthetic.remove();
      state.synthetic = null;
    }
    parts = [{ title, note: selectSectionNote(root, heading.level) }];
    if (parts[0].note) addMark(marks, root, 'cmside-headline-has-note');
  }

  const usedRows = new Set<Element>();
  const ordered = new Set<HTMLElement>();
  parts.forEach(({ title, note }, index) => {
    markTree(marks, title);
    addMark(marks, title, TITLE_CLASS);
    markPath(marks, title, card);
    if (note) {
      markTree(marks, note);
      addMark(marks, note, NOTE_CLASS);
      markPath(marks, note, card);
    }
    const row = syncMetaRow(state!, title, note);
    if (row) {
      usedRows.add(title);
      markPath(marks, row, card);
      if (context.kind === 'outline' && row.parentElement === sizer) { syncOrder(state!, row, index * 3); ordered.add(row); }
    }
    if (context.kind === 'outline') {
      if (isHTMLElement(title)) {
        const box = orderBox(title, sizer);
        addMark(marks, box, 'cmside-headline-section');
        if (!ordered.has(box)) { syncOrder(state!, box, index * 3 + 1); ordered.add(box); }
      }
      if (isHTMLElement(note)) {
        const box = orderBox(note, sizer);
        addMark(marks, box, 'cmside-headline-section');
        if (!ordered.has(box)) { syncOrder(state!, box, index * 3 + 2); ordered.add(box); }
      }
    }
  });
  for (const [title, row] of state.rows) {
    if (!usedRows.has(title)) { row.remove(); state.rows.delete(title); }
  }
  for (const [element, previous] of state.orders) {
    if (!ordered.has(element)) { restoreOrder(element, previous); state.orders.delete(element); }
  }
  // A compact subtitle may have been removed or replaced during a remount.
  for (const [element, names] of state.marks) {
    if (!isHTMLElement(element)) continue;
    if (names.has(NOTE_CLASS) && (context.kind !== 'heading' || !marks.get(element)?.has(NOTE_CLASS))) {
      element.classList.remove(CLIPPED_CLASS);
      element.style.removeProperty(SUBTITLE_LINES_VAR);
    }
    if (names.has(ROOT_CLASS) && !marks.get(element)?.has(ROOT_CLASS)) element.classList.remove(CLIPPED_CLASS);
  }
  reconcileMarks(state, marks);
  previousPreview?.remove();
  if (context.kind === 'heading') observeSubtitle(card);
  else {
    clipObserver?.unobserve(card);
    for (const element of Array.from(card.querySelectorAll(`.${CLIPPED_CLASS}`))) element.classList.remove(CLIPPED_CLASS);
    for (const note of Array.from(card.querySelectorAll(`.${NOTE_CLASS}`))) {
      if (isHTMLElement(note)) note.style.removeProperty(SUBTITLE_LINES_VAR);
    }
  }
}

// Leave native editor geometry untouched when headline decoration is removed.
export function clearHeadlineCard(card: HTMLElement): void {
  const state = cards.get(card);
  if (!state) return;
  const preview = state.preview;
  state.preview = null;
  clipObserver?.unobserve(card);
  for (const [element, names] of state.marks) element.classList.remove(...names);
  for (const row of state.rows.values()) row.remove();
  for (const [element, previous] of state.orders) restoreOrder(element, previous);
  state.synthetic?.remove();
  for (const element of Array.from(card.querySelectorAll(`.${CLIPPED_CLASS}`))) element.classList.remove(CLIPPED_CLASS);
  for (const element of Array.from(card.querySelectorAll(`[style*="${SUBTITLE_LINES_VAR}"]`))) {
    if (isHTMLElement(element)) element.style.removeProperty(SUBTITLE_LINES_VAR);
  }
  cards.delete(card);
  preview?.remove();
}

export function syncSubtitleEllipsis(note: HTMLElement): void {
  const card = note.closest('.canvas-node');
  const root = note.closest(`.${ROOT_CLASS}`);
  const rect = note.getBoundingClientRect();
  const cardClipped = isHTMLElement(card) && rect.height > 0 && rect.bottom > card.getBoundingClientRect().bottom + 1;
  if (isHTMLElement(root)) root.classList.toggle(CLIPPED_CLASS, cardClipped);
  const available = note.clientHeight;
  const lineHeight = Number.parseFloat(note.ownerDocument.defaultView?.getComputedStyle(note).lineHeight ?? '');
  const overflowing = note.scrollHeight > available + 1;
  const currentLines = Number(note.style.getPropertyValue(SUBTITLE_LINES_VAR));
  const canClamp = available > 0 && Number.isFinite(lineHeight) && lineHeight > 0;
  if (!cardClipped && overflowing && canClamp) {
    const lines = Math.max(1, Math.floor(available / lineHeight));
    if (currentLines !== lines) note.style.setProperty(SUBTITLE_LINES_VAR, String(lines));
  } else if (!overflowing && currentLines > 0 && canClamp && Math.floor(available / lineHeight) > currentLines) {
    note.style.removeProperty(SUBTITLE_LINES_VAR);
  }
  const clamped = note.style.getPropertyValue(SUBTITLE_LINES_VAR) !== '';
  note.classList.toggle(CLIPPED_CLASS, !cardClipped && overflowing && !clamped);
}

function observeSubtitle(card: HTMLElement): void {
  if (!clipObserver && typeof ResizeObserver !== 'undefined') {
    clipObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const note = entry.target.querySelector(`.${NOTE_CLASS}`);
        if (isHTMLElement(note)) syncSubtitleEllipsis(note);
      }
    });
  }
  clipObserver?.observe(card);
  if (clipFrame) clipWindow?.cancelAnimationFrame(clipFrame);
  clipWindow = card.ownerDocument.defaultView;
  if (clipWindow) {
    clipFrame = clipWindow.requestAnimationFrame(() => {
      clipFrame = 0;
      for (const target of cards.keys()) {
        if (!target.classList.contains('cmside-headline-heading')) continue;
        const note = target.querySelector(`.${NOTE_CLASS}`);
        if (isHTMLElement(note)) syncSubtitleEllipsis(note);
      }
    });
  }
}

export function applyHeadlineMode(settings: CanvasMdSideEditorSettings, doc: Document = document): void {
  if (!settings.headlineMode) {
    removeHeadlineMode(doc);
  } else {
    doc.body.classList.add(BODY_CLASS);
  }
  const sizes = [
    ['--cmside-h1-size', 'headlineH1Size', 25],
    ['--cmside-badge-size', 'headlineBadgeSize', 16],
    ['--cmside-category-size', 'headlineCategorySize', 18],
    ['--cmside-subtitle-size', 'headlineSubtitleSize', 11],
  ] as const;
  for (const [variable, key, fallback] of sizes) {
    const { min, max } = HEADLINE_SIZE_LIMITS[key];
    doc.body.style.setProperty(variable, String(clampHeadlineSize(settings[key], DEFAULT_SETTINGS[key] ?? fallback, min, max)));
  }
}

export function removeHeadlineMode(doc: Document = document): void {
  for (const card of Array.from(cards.keys())) if (card.ownerDocument === doc) clearHeadlineCard(card);
  doc.body.classList.remove(BODY_CLASS);
  if (!cards.size) {
    clipObserver?.disconnect();
    clipObserver = null;
    if (clipFrame) clipWindow?.cancelAnimationFrame(clipFrame);
    clipFrame = 0;
    clipWindow = null;
  }
}

export function clampHeadlineSize(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
