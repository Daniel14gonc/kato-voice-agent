import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { TypewriterReveal } from './typewriterReveal';

/** How long to wait for VS Code to pick up an edit the agent wrote to disk. */
const RELOAD_WAIT_MS = 3_000;
const RELOAD_POLL_MS = 100;
/** Past this, the change is a rewrite: highlight it, don't type it out. */
const MAX_TYPED_CHARS = 6_000;

/**
 * Makes the agent's edits visible as they land: opens the file, finds what
 * actually changed and "types" it in.
 *
 * The first version searched the new file for the agent's `new_string`. That
 * silently did nothing most of the time: the tool result usually arrives
 * before VS Code has reloaded the file from disk (so the text wasn't there
 * yet), MultiEdit and Codex never report the inserted text, and a snippet that
 * also appears earlier in the file got animated in the wrong place. Now every
 * edit is diffed against a snapshot taken when the agent announced it, after
 * waiting for the reload — which works for any agent and any edit tool.
 */
export class EditReveal {
  private readonly typewriter = new TypewriterReveal();
  /** fsPath → file text before the edit that is about to land. */
  private readonly baselines = new Map<string, string>();
  /** Edits are revealed one at a time, in the order they landed. */
  private queue: Promise<void> = Promise.resolve();
  private readonly washDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(129, 199, 132, 0.22)',
    isWholeLine: true,
    overviewRulerColor: '#81c784',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  /**
   * The agent announced an edit to `filePath`. Must run synchronously, before
   * the edit executes — the snapshot is the whole point.
   */
  willEdit(filePath: string): void {
    if (!this.baselines.has(filePath)) {
      this.baselines.set(filePath, currentText(filePath));
    }
    void this.open(filePath);
  }

  /** The edit landed on disk. */
  didEdit(filePath: string): void {
    this.queue = this.queue.then(() => this.reveal(filePath)).catch(() => undefined);
  }

  /** The turn ended: the user may edit files now, so old baselines are stale. */
  reset(): void {
    this.baselines.clear();
  }

  private async open(filePath: string): Promise<void> {
    // Write announces the tool before the file exists, so retry briefly.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
        return;
      } catch {
        await delay(600);
      }
    }
  }

  private async reveal(filePath: string): Promise<void> {
    const before = this.baselines.get(filePath);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch {
      return;
    }
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
    if (before === undefined) {
      return;
    }
    const after = await waitForChange(doc, before);
    // The next edit of this file in the same turn diffs against this one.
    this.baselines.set(filePath, after);
    const change = changedSpan(before, after);
    if (!change) {
      return;
    }
    const range = new vscode.Range(doc.positionAt(change.start), doc.positionAt(change.end));
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (range.isEmpty) {
      // Pure deletion: nothing to type, but show where it happened.
      return;
    }
    editor.setDecorations(this.washDecoration, [range]);
    if (change.end - change.start <= MAX_TYPED_CHARS) {
      await this.typewriter.play(editor, range);
    }
    setTimeout(() => {
      for (const visible of vscode.window.visibleTextEditors) {
        if (visible.document.uri.toString() === doc.uri.toString()) {
          visible.setDecorations(this.washDecoration, []);
        }
      }
    }, 4_000);
  }

  dispose(): void {
    this.typewriter.dispose();
    this.washDecoration.dispose();
  }
}

/** The open buffer if VS Code has one (what the user sees), else the disk. */
function currentText(filePath: string): string {
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath);
  if (open) {
    return open.getText();
  }
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return ''; // a new file: everything in it is the change
  }
}

async function waitForChange(doc: vscode.TextDocument, before: string): Promise<string> {
  const deadline = Date.now() + RELOAD_WAIT_MS;
  while (doc.getText() === before && Date.now() < deadline && !doc.isClosed) {
    await delay(RELOAD_POLL_MS);
  }
  return doc.getText();
}

/**
 * The region of `after` that differs from `before`, as offsets into `after`.
 * Common prefix and suffix are trimmed; for several separate hunks this spans
 * all of them, which is still the right place to look.
 */
export function changedSpan(before: string, after: string): { start: number; end: number } | undefined {
  if (before === after) {
    return undefined;
  }
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) {
    start++;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  // Start typing at the beginning of the line: a word appearing mid-line
  // reads as a glitch, a line being written reads as typing.
  if (endAfter > start) {
    start = start > 0 ? after.lastIndexOf('\n', start - 1) + 1 : 0;
  }
  return { start, end: endAfter };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
