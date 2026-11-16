import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian';
import { EditorSelection } from '@codemirror/state';
import { createEditor } from '../../src/editor/cm6-editor';
import { SideEditorScope } from '../../src/core/keymap-scope';

const cleanup: Array<() => void> = [];
function setup(writeText: (text: string) => Promise<void>) {
  const app = new App();
  const root = document.createElement('div');
  document.body.append(root);
  const editor = createEditor(root, 'Keep this text');
  editor.dispatch({ selection: EditorSelection.single(0, 4) });
  editor.focus();
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
  const scope = new SideEditorScope(app, () => editor);
  scope.install();
  cleanup.push(() => { scope.uninstall(); editor.destroy(); });
  return { editor, cut: app.keymap.stack.at(-1)!.registered[0].cb };
}
afterEach(() => {
  cleanup.splice(0).forEach(dispose => dispose());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('side editor cut', () => {
  it('deletes text only after copying succeeds', async () => {
    let resume!: () => void;
    const write = vi.fn(() => new Promise<void>(resolve => { resume = resolve; }));
    const { editor, cut } = setup(write);
    expect(cut()).toBe(false);
    expect(editor.state.doc.toString()).toBe('Keep this text');
    expect(write).toHaveBeenCalledWith('Keep');
    resume();
    await Promise.resolve();
    expect(editor.state.doc.toString()).toBe(' this text');
  });

  it('keeps the text when clipboard permission is denied', async () => {
    const { editor, cut } = setup(async () => { throw new Error('Denied'); });
    cut();
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.state.doc.toString()).toBe('Keep this text');
  });

  it('does not delete from a replacement document while copying is pending', async () => {
    let resume!: () => void;
    const { editor, cut } = setup(() => new Promise<void>(resolve => { resume = resolve; }));
    cut();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'Another card' } });
    resume();
    await Promise.resolve();
    expect(editor.state.doc.toString()).toBe('Another card');
  });

  it('does not change a saved buffer after the editor loses focus on close', async () => {
    let resume!: () => void;
    const { editor, cut } = setup(() => new Promise<void>(resolve => { resume = resolve; }));
    cut();
    const canvas = document.createElement('div');
    canvas.tabIndex = -1;
    document.body.append(canvas);
    canvas.focus();
    resume();
    await Promise.resolve();
    expect(editor.state.doc.toString()).toBe('Keep this text');
  });

});
