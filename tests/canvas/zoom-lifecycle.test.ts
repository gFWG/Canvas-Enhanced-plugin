import { describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian';
import { CanvasInteraction, type InteractionDelegate } from '../../src/canvas/interaction';
import type { CanvasLikeView } from '../../src/types';

function setup() {
  const containerEl = document.createElement('div');
  document.body.append(containerEl);
  const original = vi.fn(function(this: unknown, value: number) { return { receiver: this, value }; });
  const canvas = { zoomToSelection: original };
  const view = { containerEl, canvas, getViewType: () => 'canvas' } as unknown as CanvasLikeView;
  const delegate: InteractionDelegate = {
    getPanelEl: () => containerEl,
    getOpenNodeId: () => null,
    save: vi.fn(async () => {}),
    saveAndClose: vi.fn(async () => {}),
    openNode: vi.fn(async () => {}),
  };
  const interaction = new CanvasInteraction(new App(), delegate);
  interaction.attach(view);
  return { interaction, canvas, original, delegate };
}

describe('Canvas zoom lifecycle', () => {
  it('preserves a later wrapper while making its captured wrapper inert on detach', async () => {
    const { interaction, canvas, original, delegate } = setup();
    const ours = canvas.zoomToSelection;
    const later = vi.fn((value: number) => ours(value));
    canvas.zoomToSelection = later as typeof canvas.zoomToSelection;
    interaction.detach();
    expect(canvas.zoomToSelection).toBe(later);
    expect(await canvas.zoomToSelection(7)).toEqual({ receiver: canvas, value: 7 });
    expect(original).toHaveBeenCalledOnce();
    expect(delegate.saveAndClose).not.toHaveBeenCalled();
  });

  it('finishes an in-flight zoom even if the interaction detaches during the save', async () => {
    const { interaction, canvas, original, delegate } = setup();
    let resume!: () => void;
    vi.mocked(delegate.saveAndClose).mockImplementation(() => new Promise<void>(resolve => { resume = resolve; }));
    const pending = canvas.zoomToSelection(9);
    expect(delegate.saveAndClose).toHaveBeenCalledOnce();
    interaction.detach();
    expect(canvas.zoomToSelection).toBe(original);
    resume();
    expect(await pending).toEqual({ receiver: canvas, value: 9 });
    expect(original).toHaveBeenCalledOnce();
  });
});
