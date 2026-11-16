import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { App, Component, MarkdownRenderer, Plugin } from 'obsidian';
import { PreviewHelper } from '../../src/ui/preview';
import { createEditor } from '../../src/editor/cm6-editor';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(MarkdownRenderer.render).mockClear();
});

function createPlugin(app: App): Plugin {
  const plugin = new Plugin(app, { id: 'preview-test', version: '1' } as any);
  plugin.load();
  return plugin;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PreviewHelper.renderText', () => {
  it('clears the container before rendering and forwards the source path', async () => {
    const app = new App();
    const plugin = createPlugin(app);
    const helper = new PreviewHelper(app, plugin);
    const container = document.createElement('div');
    container.appendChild(document.createElement('span')); // pre-existing child
    document.body.appendChild(container);
    helper.setContainer(container);
    helper.setSourcePath('notes/foo.md');

    await helper.renderText('# hello');

    // Pre-existing children removed; mock renderer added a <p>
    expect(container.querySelector('span')).toBeFalsy();
    expect(container.querySelector('p')?.textContent).toBe('# hello');
    expect(MarkdownRenderer.render).toHaveBeenCalledTimes(1);
    const args = vi.mocked(MarkdownRenderer.render).mock.calls[0];
    expect(args[1]).toBe('# hello');
    expect(args[2]).toBe(container);
    expect(args[3]).toBe('notes/foo.md');
  });

  it('does nothing when no container has been set', async () => {
    const app = new App();
    const helper = new PreviewHelper(app, createPlugin(app));
    await helper.renderText('whatever');
    expect(MarkdownRenderer.render).not.toHaveBeenCalled();
  });
});

describe('PreviewHelper.scheduleFromEditor', () => {
  it('debounces editor updates and renders the latest text', async () => {
    vi.useFakeTimers();
    const app = new App();
    const helper = new PreviewHelper(app, createPlugin(app));
    const container = document.createElement('div');
    document.body.appendChild(container);
    helper.setContainer(container);

    const editorParent = document.createElement('div');
    document.body.appendChild(editorParent);
    const view = createEditor(editorParent, 'first');

    helper.scheduleFromEditor(view, 100);
    // schedule again before the timer fires — should reset
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'second' } });
    helper.scheduleFromEditor(view, 100);

    await vi.advanceTimersByTimeAsync(50);
    expect(MarkdownRenderer.render).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60);
    expect(MarkdownRenderer.render).toHaveBeenCalledTimes(1);
    expect(vi.mocked(MarkdownRenderer.render).mock.calls[0][1]).toBe('second');
  });

  it('clamps the delay to at least 16ms', async () => {
    vi.useFakeTimers();
    const app = new App();
    const helper = new PreviewHelper(app, createPlugin(app));
    const container = document.createElement('div');
    document.body.appendChild(container);
    helper.setContainer(container);

    const view = createEditor(document.createElement('div'), 'x');
    helper.scheduleFromEditor(view, 0);

    await vi.advanceTimersByTimeAsync(10);
    expect(MarkdownRenderer.render).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(MarkdownRenderer.render).toHaveBeenCalledTimes(1);
  });
});

describe('PreviewHelper.syncScrollFromEditor', () => {
  it('mirrors the editor scroll position onto the preview container', () => {
    const app = new App();
    const helper = new PreviewHelper(app, createPlugin(app));
    const container = document.createElement('div');
    document.body.appendChild(container);
    helper.setContainer(container);

    const fakeView = { scrollDOM: { scrollTop: 240 } } as any;
    helper.syncScrollFromEditor(fakeView);
    expect(container.scrollTop).toBe(240);
  });
});

describe('PreviewHelper lifecycle', () => {
  it('unloads rendered children on replacement and when the panel is removed', async () => {
    const app = new App();
    const plugin = createPlugin(app);
    const helper = new PreviewHelper(app, plugin);
    const container = document.createElement('div');
    const unloaded = vi.fn();
    vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, text, target, _path, owner) => {
      const child = new Component();
      child.onunload = () => unloaded(text);
      owner.addChild(child);
      target.textContent = text;
    });
    helper.setContainer(container);
    await helper.renderText('first');
    expect(unloaded).not.toHaveBeenCalled();
    await helper.renderText('second');
    expect(unloaded).toHaveBeenCalledWith('first');
    helper.setContainer(null);
    expect(unloaded).toHaveBeenCalledWith('second');
    vi.mocked(MarkdownRenderer.render).mockReset();
  });

  it('does not render a pending update after its container is removed', async () => {
    vi.useFakeTimers();
    const app = new App();
    const helper = new PreviewHelper(app, createPlugin(app));
    helper.setContainer(document.createElement('div'));
    helper.scheduleFromText(() => 'late', 20);
    helper.setContainer(null);
    await vi.advanceTimersByTimeAsync(20);
    expect(MarkdownRenderer.render).not.toHaveBeenCalled();
  });

  it('keeps an in-flight render in its old panel and renders the latest request in the new panel', async () => {
    const app = new App();
    const helper = new PreviewHelper(app, createPlugin(app));
    const oldContainer = document.createElement('div');
    const newContainer = document.createElement('div');
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const unloaded = vi.fn();
    vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, text, target, source, owner) => {
      if (text === 'old') await waiting;
      const child = new Component();
      child.onunload = () => unloaded(text);
      owner.addChild(child);
      target.textContent = `${source}:${text}`;
    });
    helper.setContainer(oldContainer);
    helper.setSourcePath('old.md');
    const first = helper.renderText('old');
    helper.setContainer(null);
    helper.setContainer(newContainer);
    helper.setSourcePath('new.md');
    await helper.renderText('new');
    resume();
    await first;
    expect(oldContainer.textContent).toBe('old.md:old');
    expect(newContainer.textContent).toBe('new.md:new');
    expect(unloaded).toHaveBeenCalledWith('old');
    helper.setContainer(null);
    expect(unloaded).toHaveBeenCalledWith('new');
    vi.mocked(MarkdownRenderer.render).mockReset();
  });
});
