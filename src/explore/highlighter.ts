import * as vscode from 'vscode';

/** Soft, theme-friendly pastel palette; segments cycle through it. */
const COLORS = [
  { bg: 'rgba(255, 213, 79, 0.22)', ruler: '#ffd54f' }, // amber
  { bg: 'rgba(129, 199, 132, 0.22)', ruler: '#81c784' }, // green
  { bg: 'rgba(100, 181, 246, 0.22)', ruler: '#64b5f6' }, // blue
  { bg: 'rgba(244, 143, 177, 0.22)', ruler: '#f48fb1' }, // pink
];

/**
 * Paints the code ranges a tour narration is talking about, synced to the
 * voice: each spoken segment lights up its lines in a distinct color, and the
 * highlights accumulate until the next stop clears them.
 */
export class TourHighlighter {
  private readonly types: vscode.TextEditorDecorationType[];
  /** Applied ranges per document, one bucket per color. */
  private applied = new Map<string, vscode.Range[][]>();

  constructor() {
    this.types = COLORS.map((c) =>
      vscode.window.createTextEditorDecorationType({
        backgroundColor: c.bg,
        isWholeLine: true,
        overviewRulerColor: c.ruler,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
      }),
    );
  }

  async highlight(uri: vscode.Uri, range: vscode.Range, index: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true });
    const colorIndex = index % this.types.length;
    const key = uri.toString();
    const buckets = this.applied.get(key) ?? this.types.map(() => []);
    this.applied.set(key, buckets);
    buckets[colorIndex].push(range);
    editor.setDecorations(this.types[colorIndex], buckets[colorIndex]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  clear(): void {
    this.applied.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      for (const type of this.types) {
        editor.setDecorations(type, []);
      }
    }
  }

  dispose(): void {
    this.clear();
    for (const type of this.types) {
      type.dispose();
    }
  }
}
