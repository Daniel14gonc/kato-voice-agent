import * as vscode from 'vscode';

/** Frame interval for the reveal animation. */
const TICK_MS = 16;
/** Per-character pace at the slow end (small blocks read as real typing). */
const MS_PER_CHAR = 12;
/** No block takes longer than this to appear, no matter its size. */
const MAX_DURATION_MS = 2_500;
const MIN_DURATION_MS = 400;

/**
 * Plays a typewriter effect over code the agent just wrote. The text is
 * already on disk and in the buffer — this only animates its *appearance*:
 * the range starts foreground-transparent and is revealed a few characters
 * per frame. Pure decorations, so the buffer, undo stack and file state are
 * never touched, and cancelling simply shows everything at once.
 */
export class TypewriterReveal {
  private readonly hideDecoration = vscode.window.createTextEditorDecorationType({
    color: 'transparent',
  });
  private timer: NodeJS.Timeout | undefined;
  private activeEditor: vscode.TextEditor | undefined;

  /**
   * Reveals `range` progressively in `editor`. Resolves when fully visible.
   * A new call (or cancel) finishes any running animation instantly.
   */
  play(editor: vscode.TextEditor, range: vscode.Range): Promise<void> {
    this.cancel();
    const doc = editor.document;
    const startOffset = doc.offsetAt(range.start);
    const totalChars = doc.offsetAt(range.end) - startOffset;
    if (totalChars <= 0) {
      return Promise.resolve();
    }
    const duration = Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, totalChars * MS_PER_CHAR));
    const charsPerTick = (totalChars * TICK_MS) / duration;

    this.activeEditor = editor;
    editor.setDecorations(this.hideDecoration, [range]);

    const version = doc.version;
    return new Promise((resolve) => {
      let revealed = 0;
      this.timer = setInterval(() => {
        revealed += charsPerTick;
        // Any further change to the document (the agent editing again, the
        // user typing) invalidates the offsets — finish instantly.
        if (revealed >= totalChars || doc.version !== version || doc.isClosed) {
          this.cancel();
          resolve();
          return;
        }
        const frontier = doc.positionAt(startOffset + Math.floor(revealed));
        editor.setDecorations(this.hideDecoration, [new vscode.Range(frontier, range.end)]);
        editor.revealRange(
          new vscode.Range(frontier, frontier),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      }, TICK_MS);
      this.timer.unref?.();
    });
  }

  /** Finishes any running animation instantly (everything becomes visible). */
  cancel(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.activeEditor?.setDecorations(this.hideDecoration, []);
    this.activeEditor = undefined;
  }

  dispose(): void {
    this.cancel();
    this.hideDecoration.dispose();
  }
}
