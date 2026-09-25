import * as vscode from 'vscode';
import type { ReferentStore } from '../conversation/referents';

export interface ContextSnapshot {
  /** Compact plain-text description fed to the router and the explainer. */
  text: string;
  hasWorkspace: boolean;
  workspaceName?: string;
  /** Selected text (trimmed to budget), when there is a non-empty selection. */
  selectionText?: string;
  /** Code visible on screen in the active editor (trimmed to budget). */
  visibleText?: string;
  activeFile?: string;
}

const MAX_SNIPPET_CHARS = 3000;
const MAX_TABS = 8;

/**
 * Kato's "eyes": what is open, what the user is looking at, what's broken.
 * snapshot() is recomputed per utterance — cheap, always fresh, never cached.
 */
export class ContextEngine {
  constructor(private readonly referents: ReferentStore) {}

  async snapshot(): Promise<ContextSnapshot> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const hasWorkspace = folders.length > 0;
    const lines: string[] = [];

    if (!hasWorkspace) {
      lines.push(
        'WORKSPACE: none — the user has NO folder or project open in VS Code. ' +
          'Code navigation, search and repo questions are impossible until they open one.',
      );
    } else {
      const names = folders.map((f) => f.name).join(', ');
      lines.push(`WORKSPACE: ${names} (${folders[0].uri.fsPath})`);
    }

    const editor = vscode.window.activeTextEditor;
    let selectionText: string | undefined;
    let visibleText: string | undefined;
    let activeFile: string | undefined;

    if (editor) {
      const doc = editor.document;
      activeFile = doc.isUntitled ? doc.uri.toString() : vscode.workspace.asRelativePath(doc.uri);
      const cursor = editor.selection.active;
      const symbol = await this.enclosingSymbol(doc, cursor);
      lines.push(
        `ACTIVE FILE: ${activeFile} (${doc.languageId}, ${doc.lineCount} lines), ` +
          `cursor at line ${cursor.line + 1}${symbol ? `, inside ${symbol}` : ''}`,
      );

      if (!editor.selection.isEmpty) {
        const sel = editor.selection;
        selectionText = clip(doc.getText(sel));
        lines.push(`SELECTION: lines ${sel.start.line + 1}-${sel.end.line + 1}`);
      }
      const visible = editor.visibleRanges[0];
      if (visible) {
        visibleText = clip(doc.getText(visible));
        lines.push(`VISIBLE: lines ${visible.start.line + 1}-${visible.end.line + 1}`);
      }

      const fileDiags = vscode.languages.getDiagnostics(doc.uri);
      const errors = fileDiags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      const warnings = fileDiags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning);
      if (errors.length > 0 || warnings.length > 0) {
        const first = errors[0] ?? warnings[0];
        lines.push(
          `PROBLEMS IN FILE: ${errors.length} errors, ${warnings.length} warnings. ` +
            `First: line ${first.range.start.line + 1}: ${first.message.slice(0, 120)}`,
        );
      }
    } else if (hasWorkspace) {
      lines.push('ACTIVE FILE: none (no editor open)');
    }

    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : undefined))
      .filter((t): t is string => t !== undefined && t !== activeFile);
    if (tabs.length > 0) {
      lines.push(`OTHER OPEN TABS: ${tabs.slice(0, MAX_TABS).join(', ')}`);
    }

    const table = this.referents.toPromptTable();
    if (table) {
      lines.push(`REFERENTS (things Kato listed; the user may point at them by number/ID):\n${table}`);
    }

    return {
      text: lines.join('\n'),
      hasWorkspace,
      workspaceName: folders[0]?.name,
      selectionText,
      visibleText,
      activeFile,
    };
  }

  /**
   * Identifiers the user is likely to say out loud, fed to the STT as
   * pronunciation bias — speech recognition mangles names like
   * `sync_playwright` unless it has seen them.
   */
  async vocabulary(): Promise<string[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return [];
    }
    const terms = new Set<string>();
    const add = (term: string) => {
      // Short or all-lowercase words are ordinary speech; they add noise.
      if (term.length >= 4 && (term.includes('_') || /[a-z][A-Z]/.test(term) || term.length >= 7)) {
        terms.add(term);
      }
    };

    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        editor.document.uri,
      );
      const visit = (list: vscode.DocumentSymbol[]) => {
        for (const symbol of list) {
          add(symbol.name.replace(/\(.*$/, ''));
          visit(symbol.children);
        }
      };
      visit(symbols ?? []);
    } catch {
      // No symbol provider for this language — the text scan below still works.
    }

    const visible = editor.visibleRanges[0];
    const text = visible ? editor.document.getText(visible) : '';
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) {
      add(match[0]);
      if (terms.size > 60) {
        break;
      }
    }
    return [...terms].slice(0, 40);
  }

  /** Name of the innermost document symbol containing the cursor, if any. */
  private async enclosingSymbol(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<string | undefined> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri,
      );
      if (!symbols) {
        return undefined;
      }
      let best: vscode.DocumentSymbol | undefined;
      const visit = (list: vscode.DocumentSymbol[]) => {
        for (const s of list) {
          if (s.range.contains(position)) {
            best = s;
            visit(s.children);
          }
        }
      };
      visit(symbols);
      return best ? `${vscode.SymbolKind[best.kind].toLowerCase()} ${best.name}` : undefined;
    } catch {
      return undefined;
    }
  }
}

function clip(text: string): string {
  return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}\n…(truncated)` : text;
}
