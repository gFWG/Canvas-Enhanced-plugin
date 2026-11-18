import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { App, __notices } from '../__mocks__/obsidian';
import { DEFAULT_SETTINGS } from '../../src/settings';
import type { CanvasLikeView, CanvasNode } from '../../src/types';

vi.mock('obsidian', async importOriginal => {
  const actual = await importOriginal<typeof import('obsidian')>();
  return {
    ...actual,
    resolveSubpath: (cache: Record<string, unknown>, subpath: string) => cache[subpath] ?? null,
  };
});

vi.mock('../../src/features/headline-mode', () => ({
  refreshHeadlineCard: vi.fn(),
  clearHeadlineCard: vi.fn(),
}));

import { HeadlineController } from '../../src/canvas/headline-controller';
import { clearHeadlineCard, refreshHeadlineCard } from '../../src/features/headline-mode';

type TestNode = {
  nodeEl: HTMLElement;
  data: CanvasNode;
  getData: () => CanvasNode;
  startEditing: (...args: unknown[]) => unknown;
  isEditing: boolean;
  blur: () => void;
  child?: { savePromise: Promise<void> | null };
};

function node(data: CanvasNode): TestNode {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'canvas-node';
  return {
    nodeEl,
    data,
    getData() { return this.data; },
    startEditing: vi.fn(function(this: TestNode) { this.isEditing = true; return 'native'; }),
    isEditing: false,
    blur() { this.isEditing = false; },
  };
}

function canvasView(initial: TestNode[]) {
  const containerEl = document.createElement('div');
  document.body.appendChild(containerEl);
  const canvas = {
    nodes: new Map<string, TestNode>(),
    addNode(n: TestNode) { this.nodes.set(n.data.id, n); containerEl.appendChild(n.nodeEl); },
    removeNode(n: TestNode) { this.nodes.delete(n.data.id); n.nodeEl.remove(); },
  };
  for (const n of initial) canvas.addNode(n);
  return { canvas, view: { containerEl, canvas } as unknown as CanvasLikeView };
}

const flush = async () => { await new Promise(resolve => setTimeout(resolve, 5)); };
let app: App;
let settings: typeof DEFAULT_SETTINGS;
let openNode: ReturnType<typeof vi.fn>;
let controller: HeadlineController;

beforeEach(() => {
  app = new App();
  settings = { ...DEFAULT_SETTINGS, headlineMode: true };
  openNode = vi.fn(async () => {});
  controller = new HeadlineController(app as any, () => settings, openNode);
  vi.clearAllMocks();
  __notices.length = 0;
});

afterEach(() => {
  controller.dispose();
  document.body.innerHTML = '';
});

describe('HeadlineController', () => {
  it('decorates and blocks only markdown file nodes, without changing native text editing', async () => {
    const note = node({ id: 'note', type: 'file', file: 'a.md' });
    const text = node({ id: 'text', type: 'text', text: '# text' });
    const image = node({ id: 'image', type: 'file', file: 'a.png' });
    const { view } = canvasView([note, text, image]);
    controller.update([view]);
    await flush();

    expect(refreshHeadlineCard).toHaveBeenCalledWith(note.nodeEl, { kind: 'outline' });
    expect(clearHeadlineCard).toHaveBeenCalledWith(text.nodeEl);
    expect(clearHeadlineCard).toHaveBeenCalledWith(image.nodeEl);
    expect(note.startEditing()).toBeUndefined();
    expect(openNode).toHaveBeenCalledWith(view, note.data);
    expect(note.isEditing).toBe(false);
    expect(text.startEditing()).toBe('native');
    expect(text.isEditing).toBe(true);
  });

  it('honors heading and block subpaths and retains the editing restriction with a missing cache', async () => {
    const note = node({ id: 'note', type: 'file', file: 'a.md', subpath: '#^block' });
    const { view } = canvasView([note]);
    app.vault.__seed('a.md', '# Heading');
    const cache = { '#Heading': { type: 'heading', current: { heading: 'Heading', level: 3 } } };
    (app as any).metadataCache = { getFileCache: vi.fn(() => cache) };
    controller.update([view]);
    await flush();
    expect(clearHeadlineCard).toHaveBeenCalledWith(note.nodeEl);
    note.startEditing();
    expect(openNode).toHaveBeenCalledWith(view, note.data);

    note.data.subpath = '#Heading';
    controller.update([view]);
    await flush();
    expect(refreshHeadlineCard).toHaveBeenCalledWith(note.nodeEl, {
      kind: 'heading', heading: { heading: 'Heading', level: 3 },
    });

    (app as any).metadataCache.getFileCache.mockReturnValue(null);
    vi.mocked(clearHeadlineCard).mockClear();
    controller.update([view]);
    await flush();
    expect(clearHeadlineCard).toHaveBeenCalledWith(note.nodeEl);
    note.startEditing();
    expect(openNode).toHaveBeenCalledTimes(2);
  });

  it('continues rendering and routes editing when an existing Canvas moves to another window', async () => {
    const note = node({ id: 'moved', type: 'file', file: 'moved.md' });
    const { view } = canvasView([note]);
    controller.update([view]);
    await flush();
    const second = new Window();
    second.document.body.appendChild(view.containerEl as any);
    vi.mocked(refreshHeadlineCard).mockClear();
    controller.update([view]);
    await new Promise(resolve => second.setTimeout(resolve, 10));

    expect(refreshHeadlineCard).toHaveBeenCalledWith(note.nodeEl, { kind: 'outline' });
    note.startEditing();
    expect(openNode).toHaveBeenCalledWith(view, note.data);
    expect(note.isEditing).toBe(false);
    controller.dispose();
    expect(note.startEditing()).toBe('native');
    await second.happyDOM.close();
  });

  it('guards new nodes before the native add operation and removes guards on deletion', async () => {
    const { canvas, view } = canvasView([]);
    const add = canvas.addNode;
    canvas.addNode = function(n: TestNode) { n.startEditing(); add.call(this, n); };
    controller.update([view]);
    const note = node({ id: 'new', type: 'file', file: 'new.md' });
    const native = note.startEditing;
    canvas.addNode(note);
    expect(note.startEditing).not.toBe(native);
    expect(openNode).toHaveBeenCalledWith(view, note.data);
    expect(note.isEditing).toBe(false);
    canvas.removeNode(note);
    expect(note.startEditing).toBe(native);
    expect(clearHeadlineCard).toHaveBeenCalledWith(note.nodeEl);
  });

  it('guards a file node added before its data is populated during Canvas loading', () => {
    const { canvas, view } = canvasView([]);
    controller.update([view]);
    const note = node({ id: 'loading', type: 'file', file: '' });
    canvas.addNode(note);
    note.data.file = 'a.md';
    note.startEditing();
    expect(note.isEditing).toBe(false);
    expect(openNode).toHaveBeenCalledWith(view, note.data);
  });

  it('keeps file editing in the panel on mode off and restores native methods on unload', async () => {
    const first = node({ id: 'same', type: 'file', file: 'a.md' });
    const second = node({ id: 'same', type: 'file', file: 'b.md' });
    const a = canvasView([first]);
    const b = canvasView([second]);
    const firstOriginal = first.startEditing;
    const secondOriginal = second.startEditing;
    controller.update([a.view, b.view]);
    first.startEditing();
    second.startEditing();
    expect(openNode).toHaveBeenNthCalledWith(1, a.view, first.data);
    expect(openNode).toHaveBeenNthCalledWith(2, b.view, second.data);
    settings.headlineMode = false;
    controller.update([a.view, b.view]);
    expect(first.startEditing()).toBeUndefined();
    expect(openNode).toHaveBeenCalledTimes(3);
    controller.dispose();
    expect(first.startEditing).toBe(firstOriginal);
    expect(second.startEditing).toBe(secondOriginal);
    expect(first.startEditing()).toBe('native');
  });

  it('commits an active inline editor through native blur when enabled', () => {
    const note = node({ id: 'note', type: 'file', file: 'a.md' });
    note.isEditing = true;
    note.blur = vi.fn(() => { note.isEditing = false; });
    const { view } = canvasView([note]);
    controller.update([view]);
    expect(note.blur).toHaveBeenCalledOnce();
    note.startEditing();
    expect(openNode).toHaveBeenCalledOnce();
  });

  it('waits for native file writes before opening the side editor', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const note = node({ id: 'note', type: 'file', file: 'a.md' });
    note.child = { savePromise: pending };
    const { view } = canvasView([note]);
    controller.update([view]);
    const pointerOpen = vi.fn();
    const waiting = controller.waitForNativeSave(view, note.data);
    void waiting.then(pointerOpen);
    note.startEditing();
    expect(openNode).not.toHaveBeenCalled();
    expect(pointerOpen).not.toHaveBeenCalled();
    note.child.savePromise = null;
    finish();
    expect(await waiting).toBe(true);
    await flush();
    expect(pointerOpen).toHaveBeenCalledOnce();
    expect(openNode).toHaveBeenCalledWith(view, note.data);
  });

  it('rejects a pointer request when its file changes during the native save', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const note = node({ id: 'note', type: 'file', file: 'a.md' });
    note.child = { savePromise: pending };
    const { view } = canvasView([note]);
    controller.update([view]);
    const waiting = controller.waitForNativeSave(view, note.data);
    note.data.file = 'other.md';
    note.child.savePromise = null;
    finish();
    expect(await waiting).toBe(false);
  });

  it.each(['subpath', 'removed', 'disposed'] as const)(
    'rejects a pointer request when the node is %s during the native save',
    async change => {
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      const note = node({ id: 'note', type: 'file', file: 'a.md', subpath: '#Old' });
      note.child = { savePromise: pending };
      const { canvas, view } = canvasView([note]);
      controller.update([view]);
      const waiting = controller.waitForNativeSave(view, note.data);
      if (change === 'subpath') note.data.subpath = '#New';
      else if (change === 'removed') canvas.removeNode(note);
      else controller.dispose();
      note.child.savePromise = null;
      finish();
      expect(await waiting).toBe(false);
    },
  );

  it('does not open a stale request after the node changes during a save', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const note = node({ id: 'note', type: 'file', file: 'a.md' });
    note.child = { savePromise: pending };
    const { view } = canvasView([note]);
    controller.update([view]);
    note.startEditing();
    note.data.file = 'other.md';
    note.child.savePromise = null;
    finish();
    await flush();
    expect(openNode).not.toHaveBeenCalled();
  });

  it('leaves a view native and reports incompatibility if active editing cannot be committed', () => {
    const note = node({ id: 'note', type: 'file', file: 'a.md' });
    note.isEditing = true;
    note.blur = vi.fn();
    const original = note.startEditing;
    const { view } = canvasView([note]);
    controller.update([view]);
    expect(note.startEditing).toBe(original);
    expect(__notices).toHaveLength(1);
    controller.update([view]);
    expect(__notices).toHaveLength(1);
  });


  it.each([true, false])('prevents native single-click editing while preserving selection and explicit editing (headline mode %s)', async mode => {
    settings.headlineMode = mode;
    const text = node({ id: 'text', type: 'text', text: '# hello' });
    const note = node({ id: 'note', type: 'file', file: 'a.md' });
    const { view } = canvasView([text, note]);
    const selection = vi.fn();
    let delayed: ReturnType<typeof setTimeout> | undefined;
    for (const n of [text, note]) {
      n.nodeEl.addEventListener('click', event => {
        selection();
        if (!event.defaultPrevented) delayed = setTimeout(() => n.startEditing(), 10);
      });
    }
    controller.update([view]);
    const click = () => new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 });
    const textClick = click();
    const noteClick = click();
    text.nodeEl.dispatchEvent(textClick);
    note.nodeEl.dispatchEvent(noteClick);
    expect(textClick.defaultPrevented).toBe(true);
    expect(noteClick.defaultPrevented).toBe(true);
    await flush();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(selection).toHaveBeenCalledTimes(2);
    expect(text.isEditing).toBe(false);
    expect(openNode).not.toHaveBeenCalled();
    expect(text.startEditing()).toBe('native');
    note.startEditing();
    expect(openNode).toHaveBeenCalledOnce();
    if (delayed) clearTimeout(delayed);
  });

  it('does not suppress native interaction with links, controls, modifiers or the active inline editor', () => {
    const text = node({ id: 'text', type: 'text', text: '# hello' });
    const { view } = canvasView([text]);
    text.nodeEl.innerHTML = '<a href="#link">link</a><button>button</button><div class="cm-editor"><span>editor</span></div><p>paragraph</p>';
    controller.update([view]);
    for (const target of text.nodeEl.querySelectorAll('a, button, .cm-editor span')) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, metaKey: true });
    text.nodeEl.querySelector('p')!.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    text.isEditing = true;
    const editing = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    text.nodeEl.querySelector('p')!.dispatchEvent(editing);
    expect(editing.defaultPrevented).toBe(false);
  });
  it('deactivates its wrapper without removing a wrapper installed later', () => {
    const note = node({ id: 'note', type: 'file', file: 'a.md' });
    const native = note.startEditing;
    const { view } = canvasView([note]);
    controller.update([view]);
    const prior = note.startEditing;
    const other = vi.fn(function(this: TestNode, ...args: unknown[]) { return prior.apply(this, args); });
    note.startEditing = other;
    controller.dispose();
    expect(note.startEditing).toBe(other);
    expect(note.startEditing()).toBe('native');
    expect(native).toHaveBeenCalledOnce();
    expect(openNode).not.toHaveBeenCalled();
  });

  it('preserves an existing wrapper when the controller unloads', () => {
    const note = node({ id: 'note', type: 'file', file: 'a.md' });
    const original = note.startEditing;
    const other = vi.fn(function(this: TestNode, ...args: unknown[]) { return original.apply(this, args); });
    note.startEditing = other;
    const { view } = canvasView([note]);
    controller.update([view]);
    note.startEditing();
    expect(other).not.toHaveBeenCalled();
    controller.dispose();
    expect(note.startEditing).toBe(other);
    expect(note.startEditing()).toBe('native');
  });
});
