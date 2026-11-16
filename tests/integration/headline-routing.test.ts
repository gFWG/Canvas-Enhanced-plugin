import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type TFile } from 'obsidian';
import CanvasMdSideEditorPlugin from '../../src/main';
import type { CanvasLikeView, CanvasNode } from '../../src/types';

interface TestNode {
  data: CanvasNode;
  nodeEl: HTMLElement;
  getData(): CanvasNode;
  startEditing: ReturnType<typeof vi.fn>;
}

function createCanvas(data: CanvasNode[]) {
  const containerEl = document.createElement('div');
  const wrapper = document.createElement('div');
  wrapper.className = 'canvas-wrapper';
  wrapper.tabIndex = -1;
  containerEl.append(wrapper);
  document.body.append(containerEl);
  const nodes = new Map<string, TestNode>();
  const canvas = {
    nodes,
    getData: () => ({ nodes: Array.from(nodes.values(), node => node.data), edges: [] }),
    addNode(node: TestNode) { nodes.set(node.data.id, node); wrapper.append(node.nodeEl); },
    removeNode(node: TestNode) { nodes.delete(node.data.id); node.nodeEl.remove(); },
    requestSave: vi.fn(),
  };
  for (const nodeData of data) {
    const nodeEl = document.createElement('div');
    nodeEl.className = 'canvas-node';
    nodeEl.dataset.nodeId = nodeData.id;
    nodeEl.innerHTML = '<div class="markdown-preview-view"><div class="markdown-preview-sizer"><h1>Preview</h1></div></div>';
    const node: TestNode = { data: nodeData, nodeEl, getData() { return this.data; }, startEditing: vi.fn() };
    canvas.addNode(node);
  }
  const view = { containerEl, contentEl: containerEl, canvas, getViewType: () => 'canvas' } as unknown as CanvasLikeView;
  return { view, canvas, nodes };
}

function pointer(element: Element, type: 'pointerdown' | 'pointerup') {
  element.dispatchEvent(new PointerEvent(type, { button: 0, clientX: 5, clientY: 5, bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const plugins: CanvasMdSideEditorPlugin[] = [];
const originalElementsFromPoint = document.elementsFromPoint;
async function startPlugin(app: App, views: CanvasLikeView[]) {
  const leaves = views.map(view => ({ view }));
  const workspace = app.workspace as any;
  workspace.getLeavesOfType = vi.fn((type: string) => type === 'canvas' ? leaves : []);
  workspace.setActiveLeaf = vi.fn((leaf: unknown) => { workspace.activeLeaf = leaf; });
  workspace.activeLeaf = leaves[0] ?? null;
  const plugin = new CanvasMdSideEditorPlugin(app, { id: 'test', version: '0.0.0' } as any);
  plugins.push(plugin);
  await plugin.onload();
  plugin.settings.headlineMode = true;
  plugin.settings.viewMode = 'editor';
  plugin.applyHeadlineMode();
  await (plugin as any).canvasWork;
  return plugin;
}

function edit(plugin: CanvasMdSideEditorPlugin, value: string) {
  const cm = (plugin as any).cmView;
  expect(cm).toBeTruthy();
  cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: value } });
}

async function open(plugin: CanvasMdSideEditorPlugin, view: CanvasLikeView, node: CanvasNode) {
  await (plugin as any).openEditorForNode(view, node);
}

async function read(app: App, filePath: string) {
  return app.vault.read(app.vault.getAbstractFileByPath(filePath) as TFile);
}

async function settle(plugin: CanvasMdSideEditorPlugin) {
  await new Promise(resolve => setTimeout(resolve, 10));
  await (plugin as any).canvasWork;
}

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.onunload();
  vi.restoreAllMocks();
  if (originalElementsFromPoint) document.elementsFromPoint = originalElementsFromPoint;
  else delete (document as any).elementsFromPoint;
  document.body.innerHTML = '';
});

describe('headline mode routing', () => {
  it('selects on single click and retains edits when reopening a note', async () => {
    const app = new App();
    (app.vault as any).__seed('note.md', 'Original');
    const data: CanvasNode = { id: 'node', type: 'file', file: 'note.md' };
    const { view, nodes } = createCanvas([data]);
    const node = nodes.get('node')!;
    const originalEdit = node.startEditing;
    const plugin = await startPlugin(app, [view]);
    (document as any).elementsFromPoint = () => [node.nodeEl];
    const session = (plugin as any).session;
    const openSpy = vi.spyOn(session, 'open');

    pointer(node.nodeEl, 'pointerdown');
    pointer(node.nodeEl, 'pointerup');
    const singleClick = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    node.nodeEl.dispatchEvent(singleClick);
    await settle(plugin);
    expect(singleClick.defaultPrevented).toBe(true);
    expect(openSpy).not.toHaveBeenCalled();
    node.startEditing(); // Obsidian's double-click calls this method.
    await settle(plugin);
    expect(originalEdit).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledTimes(1);
    edit(plugin, 'Unsaved edit');
    expect((plugin as any).panelEl.contains(document.activeElement)).toBe(true);

    pointer(node.nodeEl, 'pointerdown');
    pointer(node.nodeEl, 'pointerup');
    await settle(plugin);
    expect((plugin as any).panelEl.classList.contains('open')).toBe(false);
    expect(document.activeElement).toBe(view.containerEl.querySelector('.canvas-wrapper'));
    expect(await read(app, 'note.md')).toBe('Unsaved edit');
    node.startEditing();
    await settle(plugin);
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect((plugin as any).cmView.state.doc.toString()).toBe('Unsaved edit');
    expect(originalEdit).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps text cards native and routes note double-clicks to the panel (headline mode %s)', async mode => {
    const app = new App();
    (app.vault as any).__seed('note.md', 'File text');
    const { view, nodes } = createCanvas([
      { id: 'text', type: 'text', text: 'Canvas text' },
      { id: 'note', type: 'file', file: 'note.md' },
    ]);
    const text = nodes.get('text')!;
    const textNative = text.startEditing;
    const note = nodes.get('note')!;
    const plugin = await startPlugin(app, [view]);
    plugin.settings.headlineMode = mode;
    plugin.applyHeadlineMode();
    for (const node of [text, note]) {
      node.nodeEl.addEventListener('dblclick', () => node.startEditing());
      pointer(node.nodeEl, 'pointerdown');
      pointer(node.nodeEl, 'pointerup');
      const single = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
      node.nodeEl.dispatchEvent(single);
      expect(single.defaultPrevented).toBe(true);
    }
    await settle(plugin);
    expect((plugin as any).panelEl).toBeNull();
    expect(textNative).not.toHaveBeenCalled();
    const textDouble = new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 });
    text.nodeEl.dispatchEvent(textDouble);
    expect(textDouble.defaultPrevented).toBe(false);
    expect(textNative).toHaveBeenCalledOnce();
    expect((plugin as any).panelEl).toBeNull();
    const noteDouble = new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 });
    note.nodeEl.dispatchEvent(noteDouble);
    await settle(plugin);
    expect(noteDouble.defaultPrevented).toBe(true);
    expect((plugin as any).panelEl.classList.contains('open')).toBe(true);
    expect((plugin as any).cmView.state.doc.toString()).toBe('File text');
    const secondTextDouble = new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 });
    text.nodeEl.dispatchEvent(secondTextDouble);
    expect(secondTextDouble.defaultPrevented).toBe(false);
    expect(textNative).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('opens the side editor on title and metadata double-click without native handlers (headline mode %s)', async mode => {
    const app = new App();
    (app.vault as any).__seed('note.md', 'File text');
    const { view, nodes } = createCanvas([{ id: 'note', type: 'file', file: 'note.md' }]);
    const note = nodes.get('note')!;
    const nativeEdit = note.startEditing;
    const plugin = await startPlugin(app, [view]);
    plugin.settings.headlineMode = mode;
    plugin.applyHeadlineMode();
    await settle(plugin);
    const title = note.nodeEl.querySelector('h1')!;
    const titleDouble = new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 });
    title.dispatchEvent(titleDouble);
    await settle(plugin);
    expect(titleDouble.defaultPrevented).toBe(true);
    expect(nativeEdit).not.toHaveBeenCalled();
    expect((plugin as any).panelEl.classList.contains('open')).toBe(true);
    edit(plugin, 'Still editing');

    const badge = document.createElement('span');
    badge.className = 'cmside-hl-badge';
    note.nodeEl.append(badge);
    const badgeDouble = new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 });
    badge.dispatchEvent(badgeDouble);
    await settle(plugin);
    expect(badgeDouble.defaultPrevented).toBe(true);
    expect(nativeEdit).not.toHaveBeenCalled();
    expect((plugin as any).cmView.state.doc.toString()).toBe('Still editing');
  });

  it('moves focus out of the editor on close and rejects later restoration into the hidden panel', async () => {
    const app = new App();
    (app.vault as any).__seed('note.md', 'Original');
    const data: CanvasNode = { id: 'note', type: 'file', file: 'note.md' };
    const { view } = createCanvas([data]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, data);
    const panel = (plugin as any).panelEl as HTMLElement;
    const editor = panel.querySelector<HTMLElement>('.cm-content')!;
    const canvas = view.containerEl.querySelector<HTMLElement>('.canvas-wrapper')!;
    editor.focus();
    expect(panel.contains(document.activeElement)).toBe(true);

    await (plugin as any).session.saveAndClose(view);
    expect(panel.classList.contains('open')).toBe(false);
    expect(document.activeElement).toBe(canvas);

    // Obsidian's native picker can restore its saved focus after closing.
    editor.focus();
    expect(document.activeElement).toBe(canvas);
    expect(panel.contains(document.activeElement)).toBe(false);
  });

  it('releases focus from an iframe in the closed panel', async () => {
    const app = new App();
    (app.vault as any).__seed('note.md', 'Original');
    const data: CanvasNode = { id: 'note', type: 'file', file: 'note.md' };
    const { view } = createCanvas([data]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, data);
    const panel = (plugin as any).panelEl as HTMLElement;
    const frame = document.createElement('iframe');
    frame.srcdoc = ''; // A local empty frame; no network or scripts.
    panel.append(frame);
    frame.focus();
    expect(document.activeElement).toBe(frame);

    await (plugin as any).session.saveAndClose(view);
    const canvas = view.containerEl.querySelector<HTMLElement>('.canvas-wrapper')!;
    expect(document.activeElement).toBe(canvas);
    frame.focus();
    expect(document.activeElement).toBe(canvas);
  });

  it('does not steal focus from a dialog while closing the side editor', async () => {
    const app = new App();
    (app.vault as any).__seed('note.md', 'Original');
    const data: CanvasNode = { id: 'note', type: 'file', file: 'note.md' };
    const { view } = createCanvas([data]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, data);
    const dialogInput = document.createElement('input');
    document.body.append(dialogInput);
    dialogInput.focus();

    await (plugin as any).session.saveAndClose(view);
    expect(document.activeElement).toBe(dialogInput);
  });

  it('saves the previously bound canvas before opening the same node ID in another canvas', async () => {
    const app = new App();
    (app.vault as any).__seed('a.md', 'First file');
    (app.vault as any).__seed('b.md', 'Second file');
    const first: CanvasNode = { id: 'same', type: 'file', file: 'a.md' };
    const second: CanvasNode = { id: 'same', type: 'file', file: 'b.md' };
    const a = createCanvas([first]);
    const b = createCanvas([second]);
    const plugin = await startPlugin(app, [a.view, b.view]);
    await open(plugin, a.view, first);
    edit(plugin, 'Edited first file');
    b.nodes.get('same')!.startEditing();
    await settle(plugin);

    expect(await read(app, 'a.md')).toBe('Edited first file');
    expect(await read(app, 'b.md')).toBe('Second file');
    expect((plugin as any).cmView.state.doc.toString()).toBe('Second file');
    expect((plugin as any).session.boundView).toBe(b.view);
    expect((plugin as any).panelEl.parentElement).toBe(b.view.containerEl);
  });

  it('preserves typing during a cross-pane save before tearing down the previous panel', async () => {
    const app = new App();
    (app.vault as any).__seed('a.md', 'First file');
    (app.vault as any).__seed('b.md', 'Second file');
    const first: CanvasNode = { id: 'a', type: 'file', file: 'a.md' };
    const second: CanvasNode = { id: 'b', type: 'file', file: 'b.md' };
    const a = createCanvas([first]);
    const b = createCanvas([second]);
    const plugin = await startPlugin(app, [a.view, b.view]);
    await open(plugin, a.view, first);
    edit(plugin, 'Before switch');

    const started = deferred<void>();
    const unblock = deferred<void>();
    const originalModify = vi.mocked(app.vault.modify).getMockImplementation()!;
    let firstWrite = true;
    vi.mocked(app.vault.modify).mockImplementation(async (file, text) => {
      if (file.path === 'a.md' && firstWrite) {
        firstWrite = false;
        started.resolve();
        await unblock.promise;
      }
      return originalModify(file, text);
    });
    const opening = open(plugin, b.view, second);
    await started.promise;
    edit(plugin, 'Typed during cross-pane save');
    unblock.resolve();
    await opening;

    expect(await read(app, 'a.md')).toBe('Typed during cross-pane save');
    expect(await read(app, 'b.md')).toBe('Second file');
    expect((plugin as any).session.boundView).toBe(b.view);
    expect((plugin as any).cmView.state.doc.toString()).toBe('Second file');
  });

  it('keeps the old pane intact when a cross-pane save fails', async () => {
    const app = new App();
    (app.vault as any).__seed('a.md', 'First file');
    (app.vault as any).__seed('b.md', 'Second file');
    const first: CanvasNode = { id: 'a', type: 'file', file: 'a.md' };
    const second: CanvasNode = { id: 'b', type: 'file', file: 'b.md' };
    const a = createCanvas([first]);
    const b = createCanvas([second]);
    const plugin = await startPlugin(app, [a.view, b.view]);
    await open(plugin, a.view, first);
    edit(plugin, 'Unsaved edit');
    const failure = new Error('disk unavailable');
    vi.mocked(app.vault.modify).mockRejectedValue(failure);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(open(plugin, b.view, second)).rejects.toBe(failure);
    expect((plugin as any).session.boundView).toBe(a.view);
    expect((plugin as any).session.openNodeId).toBe('a');
    expect((plugin as any).cmView.state.doc.toString()).toBe('Unsaved edit');
    expect((plugin as any).panelEl.parentElement).toBe(a.view.containerEl);
    expect((plugin as any).panelEl.classList.contains('open')).toBe(true);
  });

  it('never writes the old editor buffer into a file whose read is pending during rapid switching', async () => {
    const app = new App();
    (app.vault as any).__seed('old.md', 'Old file');
    (app.vault as any).__seed('a.md', 'File A');
    (app.vault as any).__seed('b.md', 'File B');
    const old: CanvasNode = { id: 'old', type: 'file', file: 'old.md' };
    const a: CanvasNode = { id: 'a', type: 'file', file: 'a.md' };
    const b: CanvasNode = { id: 'b', type: 'file', file: 'b.md' };
    const { view } = createCanvas([old, a, b]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, old);
    edit(plugin, 'Edited old file');

    const readStarted = deferred<void>();
    const unblockRead = deferred<void>();
    const originalRead = vi.mocked(app.vault.read).getMockImplementation()!;
    vi.mocked(app.vault.read).mockImplementation(async file => {
      if (file.path === 'a.md') {
        readStarted.resolve();
        await unblockRead.promise;
      }
      return originalRead(file);
    });
    const openA = open(plugin, view, a);
    await readStarted.promise;
    edit(plugin, 'Typed while A was loading');
    const openB = open(plugin, view, b);
    // A background/pointer save can arrive while A's editor has not mounted.
    const pendingSave = (plugin as any).interaction.delegate.save(view);
    await Promise.resolve();
    unblockRead.resolve();
    await Promise.all([openA, openB, pendingSave]);

    expect(await read(app, 'old.md')).toBe('Typed while A was loading');
    expect(await read(app, 'a.md')).toBe('File A');
    expect(await read(app, 'b.md')).toBe('File B');
    expect((plugin as any).cmView.state.doc.toString()).toBe('File B');
  });

  it('preserves edits made while the previous file is still being saved', async () => {
    const app = new App();
    (app.vault as any).__seed('old.md', 'Original old');
    (app.vault as any).__seed('new.md', 'Original new');
    const old: CanvasNode = { id: 'old', type: 'file', file: 'old.md' };
    const next: CanvasNode = { id: 'new', type: 'file', file: 'new.md' };
    const { view } = createCanvas([old, next]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, old);
    edit(plugin, 'Edit before loading');
    const readStarted = deferred<void>();
    const unblockRead = deferred<void>();
    const writeStarted = deferred<void>();
    const unblockWrite = deferred<void>();
    const originalRead = vi.mocked(app.vault.read).getMockImplementation()!;
    vi.mocked(app.vault.read).mockImplementation(async file => {
      if (file.path === 'new.md') { readStarted.resolve(); await unblockRead.promise; }
      return originalRead(file);
    });
    const opening = open(plugin, view, next);
    await readStarted.promise;
    edit(plugin, 'Edit while loading');
    const originalModify = vi.mocked(app.vault.modify).getMockImplementation()!;
    let firstWrite = true;
    vi.mocked(app.vault.modify).mockImplementation(async (file, text) => {
      if (file.path === 'old.md' && firstWrite) {
        firstWrite = false;
        writeStarted.resolve();
        await unblockWrite.promise;
      }
      return originalModify(file, text);
    });
    unblockRead.resolve();
    await writeStarted.promise;
    edit(plugin, 'Latest edit during save');
    unblockWrite.resolve();
    await opening;
    expect(await read(app, 'old.md')).toBe('Latest edit during save');
    expect((plugin as any).cmView.state.doc.toString()).toBe('Original new');
  });

  it('preserves the last edit when closing during an in-flight save', async () => {
    const app = new App();
    (app.vault as any).__seed('old.md', 'Original old');
    (app.vault as any).__seed('new.md', 'Original new');
    const old: CanvasNode = { id: 'old', type: 'file', file: 'old.md' };
    const next: CanvasNode = { id: 'new', type: 'file', file: 'new.md' };
    const { view } = createCanvas([old, next]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, old);
    edit(plugin, 'Edit before loading');
    const readStarted = deferred<void>();
    const unblockRead = deferred<void>();
    const writeStarted = deferred<void>();
    const unblockWrite = deferred<void>();
    const originalRead = vi.mocked(app.vault.read).getMockImplementation()!;
    vi.mocked(app.vault.read).mockImplementation(async file => {
      if (file.path === 'new.md') { readStarted.resolve(); await unblockRead.promise; }
      return originalRead(file);
    });
    const opening = open(plugin, view, next);
    await readStarted.promise;
    edit(plugin, 'Edit while loading');
    const originalModify = vi.mocked(app.vault.modify).getMockImplementation()!;
    let firstWrite = true;
    vi.mocked(app.vault.modify).mockImplementation(async (file, text) => {
      if (file.path === 'old.md' && firstWrite) {
        firstWrite = false;
        writeStarted.resolve();
        await unblockWrite.promise;
      }
      return originalModify(file, text);
    });
    unblockRead.resolve();
    await writeStarted.promise;
    edit(plugin, 'Latest edit before close');
    ((plugin as any).panelEl.querySelector('.cmside-close-btn') as HTMLButtonElement).click();
    await Promise.resolve();
    unblockWrite.resolve();
    await opening;
    await settle(plugin);
    expect(await read(app, 'old.md')).toBe('Latest edit before close');
    expect(await read(app, 'new.md')).toBe('Original new');
    expect(Boolean((plugin as any).panelEl?.classList.contains('open'))).toBe(false);
  });

  it('keeps the current editor and buffer when saving before a card switch fails', async () => {
    const app = new App();
    (app.vault as any).__seed('old.md', 'Original old');
    (app.vault as any).__seed('new.md', 'Original new');
    const old: CanvasNode = { id: 'old', type: 'file', file: 'old.md' };
    const next: CanvasNode = { id: 'new', type: 'file', file: 'new.md' };
    const { view } = createCanvas([old, next]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, old);
    edit(plugin, 'Unsaved old edit');
    const started = deferred<void>();
    const unblock = deferred<void>();
    const originalRead = vi.mocked(app.vault.read).getMockImplementation()!;
    vi.mocked(app.vault.read).mockImplementation(async file => {
      if (file.path === 'new.md') { started.resolve(); await unblock.promise; }
      return originalRead(file);
    });
    const failure = new Error('disk unavailable');
    const originalModify = vi.mocked(app.vault.modify).getMockImplementation()!;
    let failWrites = false;
    vi.mocked(app.vault.modify).mockImplementation(async (file, text) => {
      if (file.path === 'old.md' && failWrites) throw failure;
      return originalModify(file, text);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const opening = open(plugin, view, next);
    await started.promise;
    edit(plugin, 'Latest unsaved edit');
    failWrites = true;
    unblock.resolve();
    await expect(opening).rejects.toBe(failure);
    expect((plugin as any).session.openNodeId).toBe('old');
    expect((plugin as any).cmView.state.doc.toString()).toBe('Latest unsaved edit');
    expect(await read(app, 'old.md')).toBe('Unsaved old edit');
    expect(await read(app, 'new.md')).toBe('Original new');
    expect((plugin as any).panelEl.classList.contains('open')).toBe(true);
  });

  it('keeps the editor open after a failed close save and allows a retry', async () => {
    const app = new App();
    (app.vault as any).__seed('old.md', 'Original old');
    const old: CanvasNode = { id: 'old', type: 'file', file: 'old.md' };
    const { view } = createCanvas([old]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, old);
    edit(plugin, 'Unsaved old edit');
    const originalModify = vi.mocked(app.vault.modify).getMockImplementation()!;
    vi.mocked(app.vault.modify).mockRejectedValue(new Error('disk unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    ((plugin as any).panelEl.querySelector('.cmside-close-btn') as HTMLButtonElement).click();
    await settle(plugin);
    expect((plugin as any).session.openNodeId).toBe('old');
    expect((plugin as any).cmView.state.doc.toString()).toBe('Unsaved old edit');
    expect((plugin as any).panelEl.classList.contains('open')).toBe(true);
    expect(await read(app, 'old.md')).toBe('Original old');

    vi.mocked(app.vault.modify).mockImplementation(originalModify);
    ((plugin as any).panelEl.querySelector('.cmside-close-btn') as HTMLButtonElement).click();
    await settle(plugin);
    expect(await read(app, 'old.md')).toBe('Unsaved old edit');
    expect((plugin as any).panelEl.classList.contains('open')).toBe(false);
  });

  it('keeps the latest edit when switching between two cards referencing the same file', async () => {
    const app = new App();
    (app.vault as any).__seed('same.md', 'Original');
    const first: CanvasNode = { id: 'first', type: 'file', file: 'same.md' };
    const second: CanvasNode = { id: 'second', type: 'file', file: 'same.md', subpath: '#Heading' };
    const { view } = createCanvas([first, second]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, first);
    edit(plugin, 'Saved before loading');
    const started = deferred<void>();
    const unblock = deferred<void>();
    const originalRead = vi.mocked(app.vault.read).getMockImplementation()!;
    vi.mocked(app.vault.read).mockImplementation(async file => {
      if (file.path === 'same.md') { started.resolve(); await unblock.promise; }
      return originalRead(file);
    });

    const opening = open(plugin, view, second);
    await started.promise;
    edit(plugin, 'Latest edit during loading');
    unblock.resolve();
    await opening;

    expect(await read(app, 'same.md')).toBe('Latest edit during loading');
    expect((plugin as any).cmView.state.doc.toString()).toBe('Latest edit during loading');
    await (plugin as any).interaction.delegate.save(view);
    expect(await read(app, 'same.md')).toBe('Latest edit during loading');
  });

  it('does not overwrite a pending file when the user closes the side panel', async () => {
    const app = new App();
    (app.vault as any).__seed('old.md', 'Old file');
    (app.vault as any).__seed('a.md', 'File A');
    const old: CanvasNode = { id: 'old', type: 'file', file: 'old.md' };
    const a: CanvasNode = { id: 'a', type: 'file', file: 'a.md' };
    const { view } = createCanvas([old, a]);
    const plugin = await startPlugin(app, [view]);
    await open(plugin, view, old);
    edit(plugin, 'Edited old file');
    const started = deferred<void>();
    const unblock = deferred<void>();
    const originalRead = vi.mocked(app.vault.read).getMockImplementation()!;
    vi.mocked(app.vault.read).mockImplementation(async file => {
      if (file.path === 'a.md') { started.resolve(); await unblock.promise; }
      return originalRead(file);
    });

    const opening = open(plugin, view, a);
    await started.promise;
    edit(plugin, 'Typed while the next file was loading');
    ((plugin as any).panelEl.querySelector('.cmside-close-btn') as HTMLButtonElement).click();
    await Promise.resolve();
    unblock.resolve();
    await opening;
    await settle(plugin);

    expect(await read(app, 'old.md')).toBe('Typed while the next file was loading');
    expect(await read(app, 'a.md')).toBe('File A');
    expect(Boolean((plugin as any).panelEl?.classList.contains('open'))).toBe(false);
  });

  it('unloads during a pending open without recreating a panel or retaining native edit guards', async () => {
    const app = new App();
    (app.vault as any).__seed('a.md', 'File A');
    const data: CanvasNode = { id: 'a', type: 'file', file: 'a.md' };
    const { view, nodes } = createCanvas([data]);
    const node = nodes.get('a')!;
    const originalEdit = node.startEditing;
    const plugin = await startPlugin(app, [view]);
    const started = deferred<void>();
    const unblock = deferred<void>();
    const originalRead = vi.mocked(app.vault.read).getMockImplementation()!;
    vi.mocked(app.vault.read).mockImplementation(async file => {
      if (file.path === 'a.md') { started.resolve(); await unblock.promise; }
      return originalRead(file);
    });
    const opening = open(plugin, view, data);
    await started.promise;
    plugin.onunload();
    unblock.resolve();
    await opening;
    await settle(plugin);
    expect((plugin as any).panelEl).toBeNull();
    expect(view.containerEl.querySelector('.canvas-md-side-editor-panel')).toBeNull();
    expect(node.startEditing).toBe(originalEdit);
    pointer(node.nodeEl, 'pointerdown');
    pointer(node.nodeEl, 'pointerup');
    await settle(plugin);
    expect((plugin as any).panelEl).toBeNull();
  });

  it.each([true, false])('retains native editing when Canvas hooks are unavailable (headline mode %s)', async mode => {
    const app = new App();
    app.vault.__seed('note.md', 'File text');
    const { view, canvas, nodes } = createCanvas([
      { id: 'text', type: 'text', text: 'Canvas text' },
      { id: 'note', type: 'file', file: 'note.md' },
    ]);
    delete (canvas as any).addNode;
    const plugin = await startPlugin(app, [view]);
    plugin.settings.headlineMode = mode;
    plugin.applyHeadlineMode();
    await open(plugin, view, nodes.get('note')!.data);
    for (const node of nodes.values()) {
      node.nodeEl.addEventListener('dblclick', () => node.startEditing());
      const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 });
      node.nodeEl.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(node.startEditing).toHaveBeenCalledOnce();
    }
  });

  it('waits until the workspace layout is ready before touching native Canvas views', async () => {
    const app = new App();
    const { view, canvas } = createCanvas([]);
    const workspace = app.workspace as any;
    let ready!: () => void;
    workspace.onLayoutReady.mockImplementation((callback: () => void) => { ready = callback; });
    workspace.getLeavesOfType = vi.fn(() => [{ view }]);
    workspace.activeLeaf = { view };
    const originalAdd = canvas.addNode;
    const plugin = new CanvasMdSideEditorPlugin(app, { id: 'test', version: '0' } as any);
    plugins.push(plugin);
    await plugin.onload();
    expect(canvas.addNode).toBe(originalAdd);
    ready();
    await (plugin as any).canvasWork;
    expect(canvas.addNode).not.toBe(originalAdd);
  });

});
