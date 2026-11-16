import { describe, it, expect, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import { writeNodeContent } from '../../src/canvas/data';
import type { CanvasLikeView, CanvasNode } from '../../src/types';

function makeView(opts: { canvas?: any; file?: TFile } = {}): CanvasLikeView {
  return { containerEl: document.createElement('div'), canvas: opts.canvas, file: opts.file } as unknown as CanvasLikeView;
}

describe('writeNodeContent — file node', () => {
  it('writes the new content via vault.modify and asks canvas to save', async () => {
    const app = new App();
    (app.vault as any).__seed('notes/a.md', 'old');
    const requestSave = vi.fn();
    const view = makeView({ canvas: { requestSave } });
    const node: CanvasNode = { id: 'n1', type: 'file', file: 'notes/a.md' };

    await writeNodeContent(app, view, node, 'n1', 'new body');

    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    const [fileArg, contentArg] = (app.vault.modify as any).mock.calls[0];
    expect((fileArg as TFile).path).toBe('notes/a.md');
    expect(contentArg).toBe('new body');
    expect(requestSave).toHaveBeenCalled();
  });

  it('rejects a missing linked file so the editor can retain unsaved text', async () => {
    const app = new App();
    const view = makeView();
    const node: CanvasNode = { id: 'n1', type: 'file', file: 'missing.md' };
    await expect(writeNodeContent(app, view, node, 'n1', 'x')).rejects.toThrow('no longer available');
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it('does not overwrite a note changed outside the editor', async () => {
    const app = new App();
    (app.vault as any).__seed('notes/a.md', 'external edit');
    const node: CanvasNode = { id: 'n1', type: 'file', file: 'notes/a.md' };
    await expect(writeNodeContent(app, makeView(), node, 'n1', 'my edit', 'original')).rejects.toThrow('changed outside');
    expect(await app.vault.read(new TFile('notes/a.md'))).toBe('external edit');
  });

  it('allows a matching baseline and an idempotent retry', async () => {
    const app = new App();
    (app.vault as any).__seed('notes/a.md', 'original');
    const node: CanvasNode = { id: 'n1', type: 'file', file: 'notes/a.md' };
    await writeNodeContent(app, makeView(), node, 'n1', 'my edit', 'original');
    await writeNodeContent(app, makeView(), node, 'n1', 'my edit', 'original');
    expect(await app.vault.read(new TFile('notes/a.md'))).toBe('my edit');
  });
});

describe('writeNodeContent — text node, in-memory canvas API', () => {
  it('prefers updateNode when present', async () => {
    const app = new App();
    const updateNode = vi.fn();
    const setNodeText = vi.fn();
    const requestSave = vi.fn();
    const view = makeView({ canvas: { updateNode, setNodeText, requestSave } });
    const node: CanvasNode = { id: 'n1', type: 'text', text: 'old' };

    await writeNodeContent(app, view, node, 'n1', 'new');

    expect(updateNode).toHaveBeenCalledWith('n1', { text: 'new' });
    expect(setNodeText).not.toHaveBeenCalled();
    expect(requestSave).toHaveBeenCalled();
  });

  it('uses setNodeText when updateNode is absent', async () => {
    const app = new App();
    const setNodeText = vi.fn();
    const requestSave = vi.fn();
    const view = makeView({ canvas: { setNodeText, requestSave } });
    const node: CanvasNode = { id: 'n1', type: 'text', text: 'old' };

    await writeNodeContent(app, view, node, 'n1', 'new');

    expect(setNodeText).toHaveBeenCalledWith('n1', 'new');
    expect(requestSave).toHaveBeenCalled();
  });

  it('propagates a failed in-memory update instead of falling back to a file rewrite', async () => {
    const app = new App();
    const updateNode = vi.fn(() => { throw new Error('update failed'); });
    const file = new TFile('board.canvas');
    (app.vault as any).__seed('board.canvas', JSON.stringify({ nodes: [{ id: 'n1', type: 'text' }], edges: [] }));
    const view = makeView({ canvas: { updateNode }, file });
    await expect(writeNodeContent(app, view, { id: 'n1', type: 'text' }, 'n1', 'new')).rejects.toThrow('update failed');
    expect(app.vault.process).not.toHaveBeenCalled();
  });

  it('rejects a node removed from live Canvas data', async () => {
    const app = new App();
    const updateNode = vi.fn();
    const view = makeView({ canvas: { updateNode, getData: () => ({ nodes: [], edges: [] }) } });
    await expect(writeNodeContent(app, view, { id: 'n1', type: 'text' }, 'n1', 'new')).rejects.toThrow('no longer available');
    expect(updateNode).not.toHaveBeenCalled();
  });
});

describe('writeNodeContent — text node, JSON fallback', () => {
  it('rewrites the .canvas file when no in-memory APIs are available', async () => {
    const app = new App();
    const file = new (TFile as any)('board.canvas') as TFile;
    const initial = { nodes: [{ id: 'n1', type: 'text', text: 'old' }, { id: 'n2', type: 'text', text: 'keep' }], edges: [] };
    (app.vault as any).__seed('board.canvas', JSON.stringify(initial));
    const view = makeView({ file });
    const node: CanvasNode = { id: 'n1', type: 'text', text: 'old' };

    await writeNodeContent(app, view, node, 'n1', 'new');

    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    const [, written] = (app.vault.modify as any).mock.calls[0];
    const parsed = JSON.parse(written);
    expect(parsed.nodes.find((n: any) => n.id === 'n1').text).toBe('new');
    expect(parsed.nodes.find((n: any) => n.id === 'n2').text).toBe('keep');
    expect(app.vault.process).toHaveBeenCalledOnce();
  });

  it('does not rewrite disk behind a live Canvas without update hooks', async () => {
    const app = new App();
    const file = new TFile('board.canvas');
    (app.vault as any).__seed('board.canvas', JSON.stringify({ nodes: [{ id: 'n1', type: 'text' }], edges: [] }));
    const view = makeView({ canvas: { requestSave: vi.fn() }, file });
    await expect(writeNodeContent(app, view, { id: 'n1', type: 'text' }, 'n1', 'new')).rejects.toThrow('unavailable in this view');
    expect(app.vault.process).not.toHaveBeenCalled();
  });

  it('rejects when the canvas file cannot be resolved', async () => {
    const app = new App();
    const view = makeView();
    const node: CanvasNode = { id: 'n1', type: 'text', text: 'old' };
    await expect(writeNodeContent(app, view, node, 'n1', 'new')).rejects.toThrow('no longer available');
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it('rejects a missing or replaced node without modifying the file', async () => {
    const app = new App();
    (app.vault as any).__seed('board.canvas', JSON.stringify({ nodes: [{ id: 'n1', type: 'file', file: 'a.md' }], edges: [] }));
    const view = makeView({ file: new TFile('board.canvas') });
    await expect(writeNodeContent(app, view, { id: 'n1', type: 'text' }, 'n1', 'new')).rejects.toThrow('no longer available');
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it('edits the current Canvas data supplied by process, preserving concurrent changes', async () => {
    const app = new App();
    const file = new TFile('board.canvas');
    (app.vault as any).__seed('board.canvas', JSON.stringify({
      nodes: [{ id: 'n1', type: 'text', text: 'old' }, { id: 'n2', type: 'text', text: 'changed meanwhile' }], edges: [],
    }));
    await writeNodeContent(app, makeView({ file }), { id: 'n1', type: 'text' }, 'n1', 'new');
    const result = JSON.parse(await app.vault.read(file));
    expect(result.nodes.map((node: CanvasNode) => node.text)).toEqual(['new', 'changed meanwhile']);
  });
});
