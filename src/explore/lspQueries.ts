import * as vscode from 'vscode';

/**
 * Thin wrappers over VS Code's built-in LSP commands. These answer precise
 * navigation questions ("who calls this?", "take me to X") locally, with no
 * LLM and no agent in the execution path.
 */

export async function findWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
  const result = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider',
    query,
  );
  return result ?? [];
}

export async function findReferences(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.Location[]> {
  const result = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeReferenceProvider',
    uri,
    position,
  );
  return result ?? [];
}

export async function findDefinition(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.Location[]> {
  const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
    'vscode.executeDefinitionProvider',
    uri,
    position,
  );
  return (result ?? []).map((loc) =>
    'targetUri' in loc ? new vscode.Location(loc.targetUri, loc.targetRange) : loc,
  );
}

/** Opens a location in the editor, reveals and selects it. */
export async function goTo(uri: vscode.Uri, range: vscode.Range): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/** One-line preview of a location for referent labels. */
export async function previewLine(uri: vscode.Uri, line: number): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.lineAt(Math.min(line, doc.lineCount - 1)).text.trim().slice(0, 80);
  } catch {
    return '';
  }
}

export function locationLabel(uri: vscode.Uri, range: vscode.Range): string {
  return `${vscode.workspace.asRelativePath(uri)}:${range.start.line + 1}`;
}

/** "la función handle click" → "handleclick": what the user said, comparable to identifiers. */
export function normalizeSymbolQuery(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

const CALLABLE_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Module,
]);

/**
 * Orders workspace symbols by how likely they are what the user meant:
 * exact name first (spoken names lose case and separators, so those are
 * normalized), then prefix, then substring; functions/classes over variables;
 * the file on screen over others; never generated or vendored code.
 */
export function rankSymbols(
  symbols: vscode.SymbolInformation[],
  query: string,
): Array<{ symbol: vscode.SymbolInformation; score: number }> {
  const wanted = normalizeSymbolQuery(query);
  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  return symbols
    .filter((symbol) => !/\/(node_modules|dist|out|build|\.venv|venv|__pycache__)\//.test(symbol.location.uri.path))
    .map((symbol) => {
      const have = normalizeSymbolQuery(symbol.name.replace(/\(.*$/, ''));
      let score = have === wanted ? 0 : have.startsWith(wanted) ? 3 : have.includes(wanted) ? 5 : 8;
      if (!CALLABLE_KINDS.has(symbol.kind)) {
        score += 1;
      }
      if (/(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/i.test(symbol.location.uri.path)) {
        score += 2;
      }
      if (symbol.location.uri.toString() === activeUri) {
        score -= 0.5;
      }
      return { symbol, score };
    })
    .sort((a, b) => a.score - b.score || a.symbol.name.length - b.symbol.name.length);
}
