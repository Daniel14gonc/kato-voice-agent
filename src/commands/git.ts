import * as vscode from 'vscode';

/**
 * Minimal shape of the built-in `vscode.git` extension API (it ships no types
 * package). Only the members Kato uses are declared.
 */
interface GitChange {
  uri: vscode.Uri;
  status: number;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string };
    workingTreeChanges: GitChange[];
    indexChanges: GitChange[];
  };
  diff(cached?: boolean): Promise<string>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
}

interface GitApi {
  repositories: GitRepository[];
}

const MAX_DIFF_CHARS = 12_000;

/** Resolves the repository containing the active file, else the first one. */
export async function getRepository(): Promise<GitRepository | undefined> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  const api = exports.getAPI(1);
  if (api.repositories.length === 0) {
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const containing = api.repositories
      .filter((repo) => activeUri.fsPath.startsWith(repo.rootUri.fsPath))
      // Deepest root wins in nested-repo setups.
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (containing) {
      return containing;
    }
  }
  return api.repositories[0];
}

export interface ChangeSummary {
  staged: string[];
  unstaged: string[];
  branch: string;
}

export function summarizeChanges(repo: GitRepository): ChangeSummary {
  const name = (change: GitChange) => vscode.workspace.asRelativePath(change.uri);
  return {
    staged: repo.state.indexChanges.map(name),
    unstaged: repo.state.workingTreeChanges.map(name),
    branch: repo.state.HEAD?.name ?? 'HEAD',
  };
}

/** Working-tree plus staged diff, clipped to a token budget. */
export async function getFullDiff(repo: GitRepository): Promise<string> {
  const [unstaged, staged] = await Promise.all([repo.diff(false), repo.diff(true)]);
  const combined = [staged && `--- staged ---\n${staged}`, unstaged && `--- unstaged ---\n${unstaged}`]
    .filter(Boolean)
    .join('\n');
  return combined.length > MAX_DIFF_CHARS
    ? `${combined.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated)`
    : combined;
}

export async function stageAll(repo: GitRepository): Promise<number> {
  const paths = repo.state.workingTreeChanges.map((change) => change.uri.fsPath);
  if (paths.length > 0) {
    await repo.add(paths);
  }
  return paths.length;
}

export async function commit(repo: GitRepository, message: string): Promise<void> {
  // Nothing staged yet: commit everything the user can see as changed.
  if (repo.state.indexChanges.length === 0) {
    await stageAll(repo);
  }
  await repo.commit(message);
}

export type { GitRepository };
