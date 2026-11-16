// Obsidian Scope that overrides Mod+X while the side panel is open.
// Canvas's "cut selected node" hotkey runs at a level that the plain CM6
// keymap (even with stopPropagation) cannot reach — pushing this scope
// makes Obsidian's keymap dispatcher check our Mod+X binding first.
import { App, Notice, Scope } from 'obsidian';
import type { EditorView } from '@codemirror/view';

export class SideEditorScope {
  private app: App;
  private getCmView: () => EditorView | null;
  private scope: Scope | null = null;

  constructor(app: App, getCmView: () => EditorView | null) {
    this.app = app;
    this.getCmView = getCmView;
  }

  // Push the scope onto Obsidian's keymap. The callback only acts when
  // focus is inside our CM6 editor — otherwise it returns true so Canvas's
  // own "cut selected node" hotkey can run unchanged.
  install(): void {
    if (this.scope) return;
    const scope = new Scope(this.app.scope);
    scope.register(['Mod'], 'x', () => {
      const cm = this.getCmView();
      const ae = cm?.contentDOM.ownerDocument.activeElement;
      if (!cm || !ae || !cm.contentDOM.contains(ae)) return true;
      const sel = cm.state.selection.main;
      let from = sel.from;
      let to = sel.to;
      if (sel.empty) {
        const line = cm.state.doc.lineAt(sel.from);
        from = line.from;
        to = line.to === cm.state.doc.length ? line.to : line.to + 1;
      }
      if (from === to) return false;
      const text = cm.state.sliceDoc(from, to);
      const state = cm.state;
      try {
        const clipboard = cm.contentDOM.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard) throw new Error('Clipboard unavailable');
        void clipboard.writeText(text).then(() => {
          // Never delete text until copying succeeds, or delete from another
          // document if a card switch/edit happened while copying.
          const active = cm.contentDOM.ownerDocument.activeElement;
          if (this.getCmView() !== cm || !active || !cm.contentDOM.contains(active)
            || cm.state.doc !== state.doc || !cm.state.selection.eq(state.selection)) return;
          cm.dispatch({
            changes: { from, to, insert: '' },
            selection: { anchor: from },
            userEvent: 'delete.cut',
          });
        }).catch(() => { new Notice('Could not copy to the clipboard. The text was kept.'); });
      } catch {
        new Notice('Could not copy to the clipboard. The text was kept.');
      }
      return false;
    });
    this.app.keymap.pushScope(scope);
    this.scope = scope;
  }

  uninstall(): void {
    if (!this.scope) return;
    try { this.app.keymap.popScope(this.scope); } catch {}
    this.scope = null;
  }
}
