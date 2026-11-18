import { describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { App } from 'obsidian';
import CanvasMdSideEditorPlugin from '../../src/main';
import type { CanvasLikeView, CanvasNode } from '../../src/types';

function makeCanvas(doc: Document, file: string) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const data: CanvasNode = { id: 'shared-id', type: 'file', file };
  const nodeEl = doc.createElement('div');
  nodeEl.className = 'canvas-node';
  nodeEl.dataset.nodeId = data.id;
  container.appendChild(nodeEl);
  const node = { nodeEl, getData: () => data, startEditing: vi.fn() };
  const nodes = new Map([[data.id, node]]);
  const canvas = {
    nodes,
    getData: () => ({ nodes: [data], edges: [] }),
    addNode: vi.fn(),
    removeNode: vi.fn(),
    requestSave: vi.fn(),
  };
  const view = { containerEl: container, contentEl: container, canvas, getViewType: () => 'canvas' } as unknown as CanvasLikeView;
  const root = {};
  const leaf = { view, getContainer: () => root, isDeferred: false };
  return { container, node, view, leaf, root };
}

describe('multiple workspace windows', () => {
  it('attaches newly inserted leaves to their own pop-outs before a layout change', async () => {
    const first = new Window();
    const second = new Window();
    const one = makeCanvas(first.document as unknown as Document, 'one.md');
    const two = makeCanvas(second.document as unknown as Document, 'two.md');
    const leaves = [one.leaf];
    const nativeEdit = two.node.startEditing;
    // All pop-outs share a floating root, but each has its own container.
    const floatingRoot = {};
    for (const leaf of [one.leaf, two.leaf]) Object.assign(leaf, { getRoot: () => floatingRoot });
    const app = new App();
    const workspace = app.workspace as any;
    workspace.getLeavesOfType = () => leaves;
    workspace.getMostRecentLeaf = (root: object) => root === floatingRoot ? leaves.at(-1)
      : leaves.find(leaf => leaf.getContainer() === root);
    const plugin = new CanvasMdSideEditorPlugin(app, { id: 'test', version: '0' } as any);
    try {
      await plugin.onload();
      workspace.__emit('window-open', {}, second);
      leaves.push(two.leaf);
      await Promise.resolve();
      await (plugin as any).canvasWork;
      const editors = (plugin as any).windows;
      expect(editors.get(one.container.ownerDocument)?.session.boundView).toBe(one.view);
      expect(editors.get(two.container.ownerDocument)?.session.boundView).toBe(two.view);
      expect(two.node.startEditing).not.toBe(nativeEdit);
    } finally {
      plugin.onunload();
      await first.happyDOM.abort();
      await second.happyDOM.abort();
    }
  });

  it('keeps edits and panels independent through focus, layout and pop-out closure', async () => {
    const popout = new Window();
    // Obsidian installs its element helpers in each window.
    const prototype = popout.HTMLElement.prototype as any;
    prototype.createDiv = function(options?: { cls?: string; text?: string }) {
      return this.createEl('div', options);
    };
    prototype.createEl = function(tag: string, options?: { cls?: string; text?: string }) {
      const element = this.ownerDocument.createElement(tag);
      if (options?.cls) element.className = options.cls;
      if (options?.text) element.textContent = options.text;
      this.appendChild(element);
      return element;
    };
    prototype.empty = function() { this.replaceChildren(); };
    prototype.setText = function(text: string) { this.textContent = text; };

    const main = makeCanvas(document, 'main.md');
    const second = makeCanvas(popout.document as unknown as Document, 'popout.md');
    const app = new App();
    app.vault.__seed('main.md', 'main original');
    app.vault.__seed('popout.md', 'popout original');
    const workspace = app.workspace as any;
    let leaves = [main.leaf, second.leaf];
    workspace.getLeavesOfType = () => leaves;
    workspace.getMostRecentLeaf = (root: object) => leaves.find(leaf => leaf.getContainer() === root);
    workspace.setActiveLeaf = (leaf: typeof main.leaf) => {
      workspace.activeLeaf = leaf;
      workspace.__emit('active-leaf-change', leaf);
    };
    workspace.activeLeaf = main.leaf;
    const plugin = new CanvasMdSideEditorPlugin(app, { id: 'test', version: '0.0.0' } as any);
    await plugin.onload();
    plugin.settings.viewMode = 'editor';
    await (plugin as any).canvasWork;
    main.node.startEditing();
    await vi.waitFor(() => expect((plugin as any).windows.get(document).session.cmView).toBeTruthy());
    second.node.startEditing();
    await vi.waitFor(() => expect((plugin as any).windows.get(second.container.ownerDocument).session.cmView).toBeTruthy());
    await (plugin as any).canvasWork;

    const editors = (plugin as any).windows;
    const mainSession = editors.get(document).session;
    const secondSession = editors.get(second.container.ownerDocument).session;
    expect(mainSession.panel.parentElement).toBe(main.container);
    expect(secondSession.panel.parentElement).toBe(second.container);
    expect(mainSession.panel.ownerDocument).toBe(document);
    expect(secondSession.panel.ownerDocument).toBe(second.container.ownerDocument);
    mainSession.cmView.dispatch({ changes: { from: 0, to: mainSession.cmView.state.doc.length, insert: 'main edited' } });
    secondSession.cmView.dispatch({ changes: { from: 0, to: secondSession.cmView.state.doc.length, insert: 'popout edited' } });

    workspace.setActiveLeaf(main.leaf);
    workspace.__emit('layout-change');
    await (plugin as any).canvasWork;
    expect(mainSession.cmView.state.doc.toString()).toBe('main edited');
    expect(secondSession.cmView.state.doc.toString()).toBe('popout edited');
    leaves = [main.leaf];
    workspace.__emit('window-close', {}, popout);
    workspace.__emit('layout-change');
    await (plugin as any).canvasWork;
    await vi.waitFor(async () => {
      const file = app.vault.getAbstractFileByPath('popout.md')!;
      expect(await app.vault.read(file)).toBe('popout edited');
    });
    expect(await app.vault.read(app.vault.getAbstractFileByPath('main.md')!)).toBe('main original');
    expect(editors.has(second.container.ownerDocument)).toBe(false);
    expect(mainSession.panel.isConnected).toBe(true);
    expect(mainSession.cmView.state.doc.toString()).toBe('main edited');
    plugin.onunload();
    main.container.remove();
    popout.happyDOM.abort();
  });
});
