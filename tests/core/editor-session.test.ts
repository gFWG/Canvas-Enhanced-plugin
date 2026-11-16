import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, MarkdownRenderer, Plugin, TFile } from 'obsidian';
import { EditorSession } from '../../src/core/editor-session';
import { DEFAULT_SETTINGS } from '../../src/settings';
import type { CanvasLikeView, CanvasNode } from '../../src/types';
import { __notices } from '../__mocks__/obsidian';

const sessions: EditorSession[] = [];
function setup() {
  const app = new App();
  app.vault.__seed('a.md', 'First note');
  app.vault.__seed('b.md', 'Second note');
  const containerEl = document.createElement('div');
  document.body.append(containerEl);
  const view = { containerEl } as CanvasLikeView;
  const plugin = new Plugin(app, { id: 'session', version: '1' } as any);
  plugin.load();
  const settings = { ...DEFAULT_SETTINGS, viewMode: 'editor' as const, fontSize: 16 };
  const session = new EditorSession({ app, plugin, getSettings: () => settings, persistSettings: vi.fn() });
  session.boundView = view;
  sessions.push(session);
  return { app, session, view };
}
const note = (id: string): CanvasNode => ({ id, type: 'file', file: `${id}.md` });
const edit = (session: EditorSession, text: string) => session.cmView!.dispatch({ changes: { from: 0, to: session.cmView!.state.doc.length, insert: text } });
function deferred() {
  let resume!: () => void;
  const promise = new Promise<void>(resolve => { resume = resolve; });
  return { promise, resume };
}
afterEach(() => {
  for (const session of sessions.splice(0)) session.teardown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __notices.length = 0;
  document.body.replaceChildren();
});

describe('source editor persistence', () => {
  it('keeps the buffer and panel open if its linked file disappears', async () => {
    const { app, session, view } = setup();
    await session.open(view, note('a'));
    edit(session, 'Unsaved');
    app.vault.getAbstractFileByPath.mockReturnValue(null);
    await expect(session.saveAndClose(view)).rejects.toThrow('no longer available');
    expect(session.cmView!.state.doc.toString()).toBe('Unsaved');
    expect(session.panel!.classList.contains('open')).toBe(true);
  });

  it('does not overwrite a note changed outside the source editor', async () => {
    const { app, session, view } = setup();
    await session.open(view, note('a'));
    edit(session, 'Local changes');
    await app.vault.modify(new TFile('a.md'), 'External changes');
    await expect(session.saveAndClose(view)).rejects.toThrow('changed outside');
    expect(await app.vault.read(new TFile('a.md'))).toBe('External changes');
    expect(session.cmView!.state.doc.toString()).toBe('Local changes');
    expect(session.panel!.classList.contains('open')).toBe(true);
  });

  it('closes an unchanged buffer without overwriting newer external content', async () => {
    const { app, session, view } = setup();
    await session.open(view, note('a'));
    await app.vault.modify(new TFile('a.md'), 'External changes');
    await session.saveAndClose(view);
    expect(await app.vault.read(new TFile('a.md'))).toBe('External changes');
    expect(session.panel!.classList.contains('open')).toBe(false);
  });

  it('loads fresh external content when reopening the same unchanged source note', async () => {
    const { app, session, view } = setup();
    await session.open(view, note('a'));
    await app.vault.modify(new TFile('a.md'), 'External changes');
    await session.open(view, { ...note('a'), id: 'other-card' });
    expect(session.cmView!.state.doc.toString()).toBe('External changes');
    edit(session, 'Edit after reload');
    await session.saveAndClose(view);
    expect(await app.vault.read(new TFile('a.md'))).toBe('Edit after reload');
  });

  it('advances the saved baseline through queued edits', async () => {
    const { app, session, view } = setup();
    await session.open(view, note('a'));
    const wait = deferred();
    const original = app.vault.process.getMockImplementation()!;
    app.vault.process.mockImplementationOnce(async (...args) => { await wait.promise; return original(...args); });
    edit(session, 'First edit');
    const first = session.save(view);
    edit(session, 'Second edit');
    const second = session.save(view);
    wait.resume();
    await Promise.all([first, second]);
    expect(await app.vault.read(new TFile('a.md'))).toBe('Second edit');
  });
});

describe('session asynchronous work', () => {
  it('never inserts delayed pasted-image links into another card', async () => {
    const { app, session, view } = setup();
    await session.open(view, note('a'));
    const editor = session.cmView!;
    const wait = deferred();
    app.vault.createBinary.mockImplementationOnce(async path => { await wait.promise; return new TFile(path); });
    const pasting = (session as any).handlePasteImages([new File(['image'], 'image.png', { type: 'image/png' })], editor);
    await session.open(view, note('b'));
    expect(session.cmView).toBe(editor); // CM6 intentionally reuses its view.
    wait.resume();
    await pasting;
    expect(session.cmView!.state.doc.toString()).toBe('Second note');
    expect(__notices.some(text => text.includes('card changed'))).toBe(true);
  });

  it('uses the native rename/link-update API without changing the next card source path', async () => {
    const { app, session, view } = setup();
    const originalNode = note('a');
    await session.open(view, originalNode);
    const wait = deferred();
    app.fileManager.renameFile.mockImplementationOnce(async (file, path) => { await wait.promise; return app.vault.rename(file, path); });
    const renaming = (session as any).commitFileRename(new TFile('a.md'), 'renamed', originalNode);
    await session.open(view, note('b'));
    wait.resume();
    await renaming;
    expect(app.fileManager.renameFile).toHaveBeenCalledOnce();
    expect(originalNode.file).toBe('renamed.md');
    expect(session.sourcePath).toBe('b.md');
    expect(session.cmView!.state.doc.toString()).toBe('Second note');
  });

  it('keeps the latest preview when typing immediately after opening', async () => {
    vi.useFakeTimers();
    const { session, view } = setup();
    await session.open(view, note('a'));
    edit(session, 'Immediate edit');
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(MarkdownRenderer.render).mock.calls.at(-1)?.[1]).toBe('Immediate edit');
  });

  it('keeps the native view alive through the captured final save during teardown', async () => {
    const { session, view } = setup();
    const wait = deferred();
    let attached = true;
    const native = { save: vi.fn(async () => { expect(attached).toBe(true); await wait.promise; expect(attached).toBe(true); }) };
    const detach = vi.fn(async () => { attached = false; });
    Object.assign(session, { currentNodeId: 'a', usingLeafHost: true, leafHost: { getView: () => native, detach } });
    const saving = session.save(view);
    session.teardown(saving);
    expect(detach).not.toHaveBeenCalled();
    wait.resume();
    await saving;
    await Promise.resolve();
    expect(detach).toHaveBeenCalledOnce();
  });
});
