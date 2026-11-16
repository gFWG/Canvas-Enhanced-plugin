// Canvas node resolution: given a screen point (or the current selection),
// resolve a node using DOM hit testing or Canvas JSON bounds.
import type { CanvasLikeView, CanvasLike, CanvasNode } from '../types';
import type { App } from 'obsidian';
import { screenToCanvasPoint } from './geometry';
import { readCanvasData } from './data';

export function findNodeIdAtPoint(clientX: number, clientY: number, doc: Document = document): string | null {
  try {
    const path = (doc.elementsFromPoint(clientX, clientY) || []) as HTMLElement[];
    for (const el of path) {
      const host = el.closest('[data-node-id], [data-id], .canvas-node, .canvas-card') as HTMLElement | null;
      if (!host) continue;
      const id = host.getAttribute('data-node-id') || host.getAttribute('data-id');
      if (id) return id;
    }
  } catch {}
  return null;
}

// Narrowing helper to ensure values are finite numbers
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export async function hitTestNodeAt(app: App, view: CanvasLikeView, clientX: number, clientY: number): Promise<string | null> {
  const data = await readCanvasData(app, view);
  if (!data) return null;
  const { x, y } = screenToCanvasPoint(view, clientX, clientY);
  const getBounds = (n: CanvasNode | Record<string, unknown>) => {
    if (typeof (n as CanvasNode).x === 'number' && typeof (n as CanvasNode).y === 'number' && typeof (n as CanvasNode).width === 'number' && typeof (n as CanvasNode).height === 'number') {
      // Canvas JSON x/y is the node's TOP-LEFT corner per the .canvas spec.
      // (A center-origin fallback used to be listed here too; its phantom
      // box extended half a node beyond the bottom-right edges and made
      // blank clicks next to a node count as hitting it.)
      return [
        { left: (n as CanvasNode).x!, top: (n as CanvasNode).y!, width: (n as CanvasNode).width!, height: (n as CanvasNode).height! },
      ];
    }
    const rec = n as Record<string, unknown>;
    const posVal = rec['pos'] as unknown;
    const sizeVal = rec['size'] as unknown;
    const posObj = (posVal && typeof posVal === 'object') ? (posVal as Record<string, unknown>) : undefined;
    const posArr = Array.isArray(posVal) ? (posVal as unknown[]) : undefined;
    const sizeObj = (sizeVal && typeof sizeVal === 'object' && !Array.isArray(sizeVal)) ? (sizeVal as Record<string, unknown>) : undefined;
    const sizeArr = Array.isArray(sizeVal) ? (sizeVal as unknown[]) : undefined;
    if ((posObj || posArr) && (sizeObj || sizeArr)) {
      const px = typeof posObj?.x === 'number' ? posObj!.x as number : (typeof posArr?.[0] === 'number' ? posArr![0] as number : undefined);
      const py = typeof posObj?.y === 'number' ? posObj!.y as number : (typeof posArr?.[1] === 'number' ? posArr![1] as number : undefined);
      const w = typeof sizeObj?.w === 'number' ? sizeObj!.w as number
              : typeof sizeObj?.width === 'number' ? sizeObj!.width as number
              : typeof sizeArr?.[0] === 'number' ? sizeArr![0] as number : undefined;
      const h = typeof sizeObj?.h === 'number' ? sizeObj!.h as number
              : typeof sizeObj?.height === 'number' ? sizeObj!.height as number
              : typeof sizeArr?.[1] === 'number' ? sizeArr![1] as number : undefined;
      if (isNum(px) && isNum(py) && isNum(w) && isNum(h)) {
        const _px = px, _py = py, _w = w, _h = h;
        return [
          { left: _px, top: _py, width: _w, height: _h },
        ];
      }
    }
    return [] as Array<{ left: number; top: number; width: number; height: number }>;
  };

  for (let i = data.nodes.length - 1; i >= 0; i--) {
    const n = data.nodes[i];
    const candidates = getBounds(n);
    for (const b of candidates) {
      if (x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height) {
        return n.id as string;
      }
    }
  }
  return null;
}
