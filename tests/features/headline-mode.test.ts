import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import {
  applyHeadlineMode,
  clampHeadlineSize,
  clearHeadlineCard,
  parseNoteTitle,
  refreshHeadlineCard,
  removeHeadlineMode,
  selectOutlineParts,
  syncSubtitleEllipsis,
} from '../../src/features/headline-mode';
import { DEFAULT_SETTINGS } from '../../src/settings';

const styles = readFileSync('styles.css', 'utf8');
const note = (id: string, title = 'Note', body = '<p>Subtitle <a href="#link">link</a></p>') =>
  `<div class="callout" data-callout="note" id="${id}"><div class="callout-title"><div class="callout-title-inner">${title}</div></div><div class="callout-content">${body}</div></div>`;

function card(content: string, title = ''): HTMLElement {
  const node = document.createElement('div');
  node.className = 'canvas-node';
  node.innerHTML = `<div class="canvas-node-content"><div class="mod-header">${title}</div><div class="markdown-preview-view markdown-rendered"><div class="markdown-preview-sizer">${content}</div></div></div>`;
  document.body.appendChild(node);
  return node;
}
const enable = () => applyHeadlineMode({ ...DEFAULT_SETTINGS, headlineMode: true });
const outline = (node: HTMLElement) => refreshHeadlineCard(node, { kind: 'outline' });
const narrow = (node: HTMLElement, heading = 'Selected', level = 2) =>
  refreshHeadlineCard(node, { kind: 'heading', heading: { heading, level } });

beforeEach(() => {
  document.body.innerHTML = '';
  const style = document.createElement('style');
  style.id = 'headline-test-styles';
  style.textContent = styles;
  document.head.append(style);
  enable();
});

afterEach(() => {
  vi.restoreAllMocks();
  removeHeadlineMode();
  document.getElementById('headline-test-styles')?.remove();
  document.body.innerHTML = '';
});

describe('headline content', () => {
  it('parses badge and category without treating default Note as a title', () => {
    expect(parseNoteTitle(' P01 | Systems | East ')).toEqual({ identifier: 'P01', category: 'Systems | East' });
    expect(parseNoteTitle('Category')).toEqual({ identifier: '', category: 'Category' });
    expect(parseNoteTitle('Note')).toEqual({ identifier: '', category: '' });
    expect(parseNoteTitle('| category')).toEqual({ identifier: '', category: 'category' });
  });

  it('selects every own heading and the first qualifying Note per H1', () => {
    const root = document.createElement('div');
    root.innerHTML = `${note('early', 'Early')}<h2>Before</h2><h1>One</h1><h2>Sub</h2>${note('one', 'A | One')}${note('ignored', 'Ignore')}<h1>Two</h1>${note('two', 'B | Two')}<h6>Last</h6><div class="markdown-embed"><h1>Embed</h1>${note('embedded')}</div><div class="callout" data-callout="warning"><h1>Nested</h1>${note('nested')}</div>`;
    const parts = selectOutlineParts(root);
    expect(parts.map(part => part.title.textContent)).toEqual(['Before', 'One', 'Sub', 'Two', 'Last']);
    expect(parts.map(part => part.note?.id ?? null)).toEqual([null, 'one', null, 'two', null]);
  });

  it('renders an H1–H6 outline and associates metadata and subtitles with the right H1', () => {
    const node = card(`<h1 id="first">One</h1><h2 id="sub">Sub</h2>${note('one', 'A | One')}<h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6><h1 id="second">Two</h1>${note('two', 'B | Two')}<p id="body">Hidden body</p>`);
    outline(node);
    const headings = Array.from(node.querySelectorAll('.cmside-headline-title'));
    expect(headings.map(h => h.textContent)).toEqual(['One', 'Sub', 'Three', 'Four', 'Five', 'Six', 'Two']);
    const rows = Array.from(node.querySelectorAll('.cmside-hl-meta'));
    expect(rows.map(row => row.textContent)).toEqual(['AOne', 'BTwo']);
    expect(node.querySelector('#first')?.previousElementSibling).toBe(rows[0]);
    expect(node.querySelector('#second')?.previousElementSibling).toBe(rows[1]);
    expect(node.querySelector('#one')?.classList.contains('cmside-headline-note')).toBe(true);
    expect(node.querySelector('#two')?.classList.contains('cmside-headline-note')).toBe(true);
    expect(getComputedStyle(node.querySelector('#body')!).display).toBe('none');
    // The first subtitle visually follows its owning H1 even when it occurs after H2.
    expect(Number((node.querySelector('#first') as HTMLElement).style.order)).toBeLessThan(Number((node.querySelector('#one') as HTMLElement).style.order));
    expect(Number((node.querySelector('#one') as HTMLElement).style.order)).toBeLessThan(Number((node.querySelector('#sub') as HTMLElement).style.order));
    expect(getComputedStyle(node.querySelector('.cmside-headline-root')!).overflowY).toBe('hidden');
    // Separate fixtures avoid Happy DOM's cached :not() ancestor matching.
    const focused = node.cloneNode(true) as HTMLElement;
    focused.classList.add('is-focused');
    document.body.append(focused);
    expect(getComputedStyle(focused.querySelector('.cmside-headline-root')!).overflowY).toBe('auto');
  });

  it('accepts H2-only notes without a placeholder and marks genuinely heading-free notes empty', () => {
    const noH1 = card('<h2>Heading</h2><p>Body</p>');
    const empty = card('<p>Body</p>');
    outline(noH1);
    outline(empty);
    expect(noH1.querySelector('.cmside-headline-title')?.textContent).toBe('Heading');
    expect(noH1.querySelector('.cmside-headline-empty')).toBeNull();
    expect(empty.querySelector('.cmside-headline-empty')).not.toBeNull();
  });

  it('retains off-screen native sections and restores the virtual scroller on exit', () => {
    const node = card('');
    const preview = node.querySelector('.markdown-preview-view') as HTMLElement;
    const sizer = preview.querySelector('.markdown-preview-sizer') as HTMLElement;
    const pusher = document.createElement('div');
    pusher.className = 'markdown-preview-pusher';
    const first = document.createElement('div');
    first.className = 'el-h1';
    first.innerHTML = '<h1>First</h1>';
    const paragraph = document.createElement('div');
    paragraph.className = 'el-p';
    paragraph.innerHTML = '<p>Hidden body</p>';
    const second = document.createElement('div');
    second.className = 'el-h2';
    second.innerHTML = '<h2>Last heading</h2>';
    const subtitle = document.createElement('div');
    subtitle.innerHTML = note('late-note', 'A | Category');
    const original = vi.fn(function() {
      expect(node.classList.contains('cmside-headline-card')).toBe(false);
      sizer.replaceChildren(pusher, first);
      pusher.style.marginBottom = '600px';
      sizer.style.minHeight = '900px';
    });
    const resetCompute = vi.fn();
    const queueRender = vi.fn();
    const renderer = {
      previewEl: preview,
      sizerEl: sizer,
      pusherEl: pusher,
      sections: [first, paragraph, second, subtitle].map(el => ({ el, resetCompute })),
      updateVirtualDisplay: original,
      queueRender,
    };
    original(); // Simulate Obsidian detaching off-screen sections.
    original.mockClear();
    refreshHeadlineCard(node, { kind: 'outline', renderer });

    expect(Array.from(node.querySelectorAll('.cmside-headline-title')).map(el => el.textContent)).toEqual(['First', 'Last heading']);
    expect(sizer.children[0]).toBe(pusher);
    expect(getComputedStyle(pusher).display).not.toBe('none');
    expect(getComputedStyle(first).display).toBe('block');
    expect(getComputedStyle(paragraph).display).toBe('block');
    expect(getComputedStyle(paragraph.querySelector('p')!).display).toBe('none');
    expect(pusher.style.marginBottom).toBe('0px');
    expect(sizer.style.minHeight).toBe('');
    expect(Number(first.style.order)).toBeLessThan(Number(subtitle.style.order));
    expect(Number(subtitle.style.order)).toBeLessThan(Number(second.style.order));

    renderer.updateVirtualDisplay();
    expect(original).not.toHaveBeenCalled();
    expect(sizer.contains(second)).toBe(true);
    clearHeadlineCard(node);
    expect(renderer.updateVirtualDisplay).toBe(original);
    expect(original).toHaveBeenCalledOnce();
    expect(resetCompute).toHaveBeenCalledTimes(4);
    expect(queueRender).toHaveBeenCalledOnce();
    expect(sizer.contains(second)).toBe(false);
    expect(pusher.style.marginBottom).toBe('600px');
  });

  it('leaves a later virtualizer wrapper in place but deactivates the outline hook', () => {
    const node = card('');
    const preview = node.querySelector('.markdown-preview-view') as HTMLElement;
    const sizer = preview.querySelector('.markdown-preview-sizer') as HTMLElement;
    const pusher = document.createElement('div');
    pusher.className = 'markdown-preview-pusher';
    const section = document.createElement('div');
    section.innerHTML = '<h1>Heading</h1>';
    const native = vi.fn();
    const renderer = { previewEl: preview, sizerEl: sizer, pusherEl: pusher, sections: [{ el: section }], updateVirtualDisplay: native };
    refreshHeadlineCard(node, { kind: 'outline', renderer });
    const pluginWrapper = renderer.updateVirtualDisplay;
    const laterWrapper = vi.fn(() => pluginWrapper.call(renderer));
    renderer.updateVirtualDisplay = laterWrapper;
    clearHeadlineCard(node);
    expect(renderer.updateVirtualDisplay).toBe(laterWrapper);
    expect(native).toHaveBeenCalledOnce();
  });

  it('does not create vertical gaps for hidden native sections before headings', () => {
    const sections = Array.from({ length: 84 }, (_, index) =>
      `<div class="el-p" id="hidden-${index}"><p>Hidden body ${index}</p></div>`).join('');
    const node = card(`${sections}<div class="el-h1" id="visible-section"><h1>Visible</h1></div>`);
    outline(node);
    const preview = node.querySelector('.markdown-preview-view') as HTMLElement;
    const sizer = node.querySelector('.markdown-preview-sizer') as HTMLElement;
    const hidden = node.querySelector('#hidden-0') as HTMLElement;
    const visible = node.querySelector('#visible-section') as HTMLElement;

    expect(getComputedStyle(preview).display).toBe('block');
    expect(Number.parseFloat(getComputedStyle(sizer).gap)).toBe(0);
    expect(getComputedStyle(sizer).alignItems).toBe('stretch');
    expect(hidden.classList.contains('cmside-headline-section')).toBe(false);
    expect(getComputedStyle(hidden).display).toBe('block');
    expect(Number.parseFloat(getComputedStyle(hidden).height)).toBe(0);
    expect(Number.parseFloat(getComputedStyle(hidden).margin)).toBe(0);
    expect(visible.classList.contains('cmside-headline-section')).toBe(true);
    expect(Number.parseFloat(getComputedStyle(visible).height)).not.toBe(0);
  });

  it('leaves a native virtualized preview unmodified when its renderer is unavailable', () => {
    const node = card('<div class="markdown-preview-pusher"></div><div class="el-h1"><h1>Partial</h1></div>');
    outline(node);
    expect(node.classList.contains('cmside-headline-card')).toBe(false);
    expect(node.querySelector('.cmside-headline-empty')).toBeNull();
  });

  it('updates rows after rerender without duplication, and removes stale metadata', () => {
    const node = card(`<h1>Heading</h1>${note('first', 'A | One')}${note('second', 'B | Two')}`);
    outline(node);
    const first = node.querySelector('#first')!;
    const second = node.querySelector('#second')!;
    const row = node.querySelector('.cmside-hl-meta');
    outline(node);
    expect(node.querySelector('.cmside-hl-meta')).toBe(row);
    expect(node.querySelectorAll('.cmside-hl-meta')).toHaveLength(1);
    first.before(second);
    outline(node);
    expect(node.querySelector('.cmside-hl-meta')?.textContent).toBe('BTwo');
    expect(first.classList.contains('cmside-headline-note')).toBe(false);
    second.setAttribute('data-callout', 'warning');
    outline(node);
    expect(node.querySelector('.cmside-hl-meta')?.textContent).toBe('AOne');
    first.querySelector('.callout-title-inner')!.textContent = 'Note';
    outline(node);
    expect(node.querySelector('.cmside-hl-meta')).toBeNull();
    expect(first.classList.contains('cmside-headline-note')).toBe(true);
  });

  it('does not style non-decorated cards when headline mode is active', () => {
    const node = card('<h1>Text card</h1><p id="body">Native</p>', '<div class="inline-title">Text title</div>');
    expect(node.classList.contains('cmside-headline-card')).toBe(false);
    expect(getComputedStyle(node.querySelector('.inline-title')!).display).not.toBe('none');
    expect(getComputedStyle(node.querySelector('#body')!).display).not.toBe('none');
  });

  it('keeps headline rendering after a card moves into another window', () => {
    const node = card('<h1>Moved heading</h1><h2>Section</h2>');
    const otherWindow = new Window();
    const doc = otherWindow.document as unknown as Document;
    doc.body.appendChild(node);
    // Adopted nodes retain their original realm in browsers. happy-dom shares
    // constructors across windows, so make the destination constructor distinct.
    Object.defineProperty(otherWindow, 'HTMLElement', { configurable: true, value: class OtherHTMLElement {} });
    outline(node);
    expect(node.querySelector('.cmside-headline-title')?.textContent).toBe('Moved heading');
    expect((node.querySelector('h1') as HTMLElement).style.order).toBe('1');
    clearHeadlineCard(node);
    expect(node.classList.contains('cmside-headline-card')).toBe(false);
    void otherWindow.happyDOM.close();
  });

  it('decorates and clears cards belonging to another document', () => {
    const otherWindow = new Window();
    const doc = otherWindow.document as unknown as Document;
    doc.body.innerHTML = '<div class="canvas-node"><div class="markdown-preview-view"><div class="markdown-preview-sizer"><h2>Other window</h2></div></div></div>';
    const node = doc.querySelector('.canvas-node') as HTMLElement;
    applyHeadlineMode({ ...DEFAULT_SETTINGS, headlineMode: true }, doc);
    outline(node);
    expect(node.querySelector('.cmside-headline-title')?.textContent).toBe('Other window');
    removeHeadlineMode(doc);
    expect(node.classList.contains('cmside-headline-card')).toBe(false);
    void otherWindow.happyDOM.close();
  });
});

describe('narrowed headings', () => {
  it.each([1, 2, 3, 4, 5, 6])('promotes a selected H%i in a separate native title', level => {
    const node = card(`${note('sub', 'A | Category')}<p id="body">Hidden</p>`, `<div class="inline-title" data-level="${level}"><h${level}>Selected</h${level}></div>`);
    narrow(node, 'Selected', level);
    const title = node.querySelector(`.inline-title h${level}`)!;
    expect(title.classList.contains('cmside-headline-title')).toBe(true);
    expect(getComputedStyle(node.querySelector('.mod-header')!).display).not.toBe('none');
    expect(node.querySelector('.cmside-hl-meta')?.textContent).toBe('ACategory');
    expect(node.querySelector('#sub')?.classList.contains('cmside-headline-note')).toBe(true);
    expect(getComputedStyle(node.querySelector('#body')!).display).toBe('none');
    expect(node.querySelector('.cmside-headline-empty')).toBeNull();
  });

  it('uses native plain-text title, stops at the next equal or higher heading, and keeps nested lower levels inside the section', () => {
    const node = card(`<h3>Child</h3>${note('within', 'A | Within')}<h2>Next section</h2>${note('after', 'B | After')}`, '<div class="inline-title" data-level="2">Selected</div>');
    narrow(node);
    expect(node.querySelector('.inline-title')?.classList.contains('cmside-headline-title')).toBe(true);
    expect(node.querySelector('.cmside-hl-meta')?.textContent).toBe('AWithin');
    expect(node.querySelector('#after')?.classList.contains('cmside-headline-note')).toBe(false);
    const other = card(`<h2>Next</h2>${note('late', 'Late')}`, '<div class="inline-title">Selected</div>');
    narrow(other);
    expect(other.querySelector('.cmside-headline-note')).toBeNull();
  });

  it('creates a fallback title only when the native title is absent and removes it when it appears', () => {
    const node = card(note('sub', 'Category'));
    narrow(node, 'Selected H4', 4);
    expect(node.querySelector('.cmside-headline-synthetic')?.textContent).toBe('Selected H4');
    const header = node.querySelector('.mod-header')!;
    header.innerHTML = '<div class="inline-title"><h4>Selected H4</h4></div>';
    narrow(node, 'Selected H4', 4);
    expect(node.querySelector('.cmside-headline-synthetic')).toBeNull();
    expect(node.querySelectorAll('.cmside-headline-title')).toHaveLength(1);
  });

  it('leaves unresolved heading targets native', () => {
    const node = card('<p>Native content</p>');
    refreshHeadlineCard(node, { kind: 'heading' });
    expect(node.classList.contains('cmside-headline-card')).toBe(false);
    expect(node.querySelector('.cmside-headline-empty')).toBeNull();
  });
});

describe('cleanup and clipping', () => {
  it('restores native block presentation and previous order through repeated transitions', () => {
    const node = card(`<h1 style="order: 12">Title</h1><h2>Sub</h2>${note('n1', 'A | One')}`);
    outline(node);
    const title = node.querySelector('h1') as HTMLElement;
    expect(title.style.order).not.toBe('12');
    refreshHeadlineCard(node, { kind: 'native' });
    expect(title.style.order).toBe('12');
    expect(node.querySelector('.cmside-hl-meta')).toBeNull();
    expect(node.querySelector('[class*="cmside-headline-"]')).toBeNull();
    expect(node.classList.contains('cmside-headline-card')).toBe(false);
    expect(getComputedStyle(node.querySelector('#n1 .callout-title')!).display).not.toBe('none');
    outline(node);
    clearHeadlineCard(node);
    expect(title.style.order).toBe('12');
  });

  it('releases removed preview roots and metadata on a refresh', () => {
    const node = card(`<h1>First</h1>${note('first', 'A | First')}`);
    outline(node);
    const oldRoot = node.querySelector('.markdown-preview-view')!;
    oldRoot.outerHTML = '<div class="markdown-preview-view"><div class="markdown-preview-sizer"><h2>New</h2></div></div>';
    outline(node);
    expect(node.querySelector('.cmside-headline-title')?.textContent).toBe('New');
    expect(oldRoot.querySelector('.cmside-hl-meta')).toBeNull();
    expect(oldRoot.querySelector('.cmside-headline-title')).toBeNull();
  });

  it('clamps an overflowing compact subtitle and cleans its markers', () => {
    const node = card(note('n1', 'A | One'), '<div class="inline-title">Selected</div>');
    narrow(node);
    const subtitle = node.querySelector('#n1') as HTMLElement;
    Object.defineProperty(subtitle, 'clientHeight', { configurable: true, get: () => 40 });
    Object.defineProperty(subtitle, 'scrollHeight', { configurable: true, get: () => 120 });
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: '20px' } as CSSStyleDeclaration);
    syncSubtitleEllipsis(subtitle);
    expect(subtitle.style.getPropertyValue('--cmside-subtitle-lines')).toBe('2');
    clearHeadlineCard(node);
    expect(subtitle.style.getPropertyValue('--cmside-subtitle-lines')).toBe('');
  });

  it('marks the preview when the card frame clips a compact subtitle', () => {
    const node = card(note('n1', 'A | One'), '<div class="inline-title">Selected</div>');
    narrow(node);
    const subtitle = node.querySelector('#n1') as HTMLElement;
    const root = node.querySelector('.cmside-headline-root') as HTMLElement;
    subtitle.getBoundingClientRect = () => ({ top: 0, bottom: 200, height: 200, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    node.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    syncSubtitleEllipsis(subtitle);
    expect(root.classList.contains('cmside-headline-subtitle-clipped')).toBe(true);
    clearHeadlineCard(node);
    expect(root.classList.contains('cmside-headline-subtitle-clipped')).toBe(false);
  });

  it('clamps configurable sizes and removes decorations on mode disable', () => {
    const node = card('<h1>Title</h1>');
    outline(node);
    expect(clampHeadlineSize(Number.NaN, 22, 5, 60)).toBe(22);
    expect(clampHeadlineSize(100, 22, 5, 60)).toBe(60);
    applyHeadlineMode({ ...DEFAULT_SETTINGS, headlineMode: false });
    expect(node.classList.contains('cmside-headline-card')).toBe(false);
    expect(document.body.classList.contains('cmside-headline-mode')).toBe(false);
  });

  it.each(['outline', 'heading'] as const)('keeps configured pixel font sizes when a %s card is resized', kind => {
    applyHeadlineMode({
      ...DEFAULT_SETTINGS, headlineMode: true,
      headlineH1Size: 30, headlineBadgeSize: 20,
      headlineCategorySize: 18, headlineSubtitleSize: 14,
    });
    const subtitle = note('subtitle', 'P01 | Category');
    const node = kind === 'outline'
      ? card(`<h1>Title</h1>${subtitle}`)
      : card(subtitle, '<div class="inline-title">Title</div>');
    if (kind === 'outline') outline(node);
    else narrow(node, 'Title', 1);
    const placeholder = document.createElement('div');
    placeholder.className = 'canvas-node-placeholder';
    node.append(placeholder);
    for (const [width, height] of [[400, 200], [600, 300], [800, 100]]) {
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
      for (const [selector, expected] of [
        ['.cmside-headline-title', '30px'],
        ['.cmside-hl-badge', '20px'],
        ['.cmside-hl-category', '18px'],
        ['.cmside-headline-note', '14px'],
        ['.canvas-node-placeholder', '30px'],
      ]) {
        expect(getComputedStyle(node.querySelector(selector)!).fontSize).toBe(expected);
      }
    }
  });
});
