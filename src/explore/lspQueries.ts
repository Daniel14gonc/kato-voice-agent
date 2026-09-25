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
