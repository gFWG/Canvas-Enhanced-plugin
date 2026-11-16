// Canvas data access layer: reading canvas JSON, resolving nodes, and
// writing edited content back — both through Obsidian's (undocumented)
// in-memory Canvas APIs and via direct file rewrites as a fallback.
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { CanvasData, CanvasNode, CanvasLikeView, CanvasLike } from '../types';

export function resolveVaultFile(app: App, path: string): TFile | null {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : null;
}

export async function readCanvasData(app: App, view: CanvasLikeView): Promise<CanvasData | null> {
  try {
    const canvas: CanvasLike | undefined = view?.canvas as CanvasLike | undefined;
    if (canvas?.getData) {
      const dataUnknown = canvas.getData();
      if (isCanvasData(dataUnknown)) return dataUnknown;
    }
  } catch {}
  try {
    const file: TFile | undefined = view?.file as TFile | undefined;
    if (!file) return null;
    const raw = await app.vault.read(file);
    const data: unknown = JSON.parse(raw);
    return isCanvasData(data) ? data : null;
  } catch {
    return null;
  }
}

export async function getCanvasNodeById(app: App, view: CanvasLikeView, nodeId: string): Promise<CanvasNode | null> {
  const data = await readCanvasData(app, view);
  if (!data) return null;
  const node = data.nodes.find((n) => n.id === nodeId);
  return node ?? null;
}

export async function writeNodeContent(
  app: App,
  view: CanvasLikeView,
  currentNode: CanvasNode | null,
  nodeId: string,
  text: string,
  expectedText?: string,
): Promise<void> {
  const node = currentNode;
  if (!node || node.id !== nodeId) throw new Error('Canvas node is no longer available');
  if (node.type === 'file') {
    if (typeof node.file !== 'string') throw new Error('Canvas note has no file path');
    const mdFile = resolveVaultFile(app, node.file);
    if (!mdFile) throw new Error('Canvas note file is no longer available');
    if (expectedText === undefined) {
      await app.vault.modify(mdFile, text);
    } else {
      await app.vault.process(mdFile, current => {
        if (current !== expectedText && current !== text) {
          throw new Error('The note changed outside the side editor');
        }
        return text;
      });
    }
    // try to ask canvas to refresh/save
    try {
      const canvas = view?.canvas;
      if (canvas?.requestSave) canvas.requestSave();
    } catch {}
    return;
  }
  if (node.type !== 'text') throw new Error('Canvas node cannot contain text');
  // Try the in-memory Canvas API first. If it fails, propagate the failure
  // instead of reporting success or writing over a live Canvas on disk.
  const canvas: CanvasLike | undefined = view?.canvas as CanvasLike | undefined;
  if (canvas?.getData) {
    const liveData = canvas.getData();
    if (!isCanvasData(liveData)) throw new Error('Canvas data is unavailable');
    const liveNode = liveData.nodes.find(n => n.id === nodeId);
    if (!liveNode || liveNode.type !== 'text') throw new Error('Canvas text node is no longer available');
  }
  if (canvas?.updateNode) {
    canvas.updateNode(nodeId, { text });
    canvas.requestSave?.();
    return;
  }
  if (canvas?.setNodeText) {
    canvas.setNodeText(nodeId, text);
    canvas.requestSave?.();
    return;
  }
  if (canvas) {
    // A loaded Canvas may have unsaved in-memory changes. Updating only its
    // backing file could be overwritten by its next native save.
    throw new Error('Canvas text editing is unavailable in this view');
  }

  // A detached file-only view can safely update its current JSON atomically.
  const maybeFile: unknown = view?.file;
  if (!(maybeFile instanceof TFile)) throw new Error('Canvas file is no longer available');
  const file: TFile = maybeFile;
  await app.vault.process(file, raw => {
    const data: unknown = JSON.parse(raw);
    if (!isCanvasData(data)) throw new Error('Invalid Canvas file');
    const target = data.nodes.find(n => n && n.id === nodeId);
    if (!target || target.type !== 'text') throw new Error('Canvas text node is no longer available');
    target.text = text;
    return JSON.stringify(data, null, 2);
  });
}

function isCanvasData(x: unknown): x is CanvasData {
  if (!x || typeof x !== 'object') return false;
  const obj = x as Record<string, unknown>;
  return Array.isArray(obj.nodes) && Array.isArray(obj.edges)
    && obj.nodes.every(node => node && typeof node === 'object' && typeof node.id === 'string');
}
