import { execFile } from 'node:child_process';
import { getRepository } from './git';

/**
 * Plain `git` for what the built-in Git extension API does not expose
 * (stash, merge, log ranges, remotes, ahead/behind). Always run in the
 * repository of the active file.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        // Never block on an editor or a credential prompt nobody can see.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GitError(String(stderr || err.message).trim().split('\n').slice(-3).join(' '), String(stderr)));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

export async function repoRoot(): Promise<string | undefined> {
  return (await getRepository())?.rootUri.fsPath;
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])).trim().length > 0;
}

/** origin's default branch (main, master, develop…), without the remote prefix. */
export async function defaultBranch(cwd: string): Promise<string> {
  try {
    const ref = (await git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    return ref.replace(/^refs\/remotes\/origin\//, '');
  } catch {
    const local = await listBranches(cwd);
    return local.find((b) => b === 'main') ?? local.find((b) => b === 'master') ?? 'main';
  }
}

/** Local branches plus remote ones not checked out yet (without "origin/"). */
export async function listBranches(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
  const names = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/HEAD') && line !== 'origin')
    .map((line) => line.replace(/^origin\//, ''));
  return [...new Set(names)];
}

function squash(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The branch the user meant. Speech loses separators and case ("feature
 * login" for feature/login), so names are compared squashed; then by
 * containment; then by shared words. Undefined when nothing is close.
 */
export function matchBranch(spoken: string, branches: string[]): { name: string; exact: boolean } | undefined {
  const wanted = squash(spoken.replace(/^(la |the )?(rama|branch)\s+/i, ''));
  if (!wanted) {
    return undefined;
  }
  const exact = branches.find((b) => squash(b) === wanted);
  if (exact) {
    return { name: exact, exact: true };
  }
  const containing = branches
    .filter((b) => squash(b).includes(wanted) || (wanted.length > 4 && wanted.includes(squash(b))))
    .sort((a, b) => a.length - b.length)[0];
  if (containing) {
    return { name: containing, exact: false };
  }
  const words = spoken.toLowerCase().split(/[\s/_-]+/).filter((w) => w.length > 2);
  let best: { name: string; score: number } | undefined;
  for (const branch of branches) {
    const parts = branch.toLowerCase().split(/[\s/_-]+/);
    const score = words.filter((w) => parts.some((p) => p.includes(w))).length;
    if (score > 0 && (!best || score > best.score)) {
      best = { name: branch, score };
    }
  }
  return best && best.score >= Math.min(2, words.length) ? { name: best.name, exact: false } : undefined;
}

/** "git@github.com:owner/repo.git" / "https://github.com/owner/repo" → { owner, repo }. */
export async function githubSlug(cwd: string): Promise<{ owner: string; repo: string } | undefined> {
  try {
    const url = (await git(cwd, ['remote', 'get-url', 'origin'])).trim();
    const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
    return match ? { owner: match[1], repo: match[2] } : undefined;
  } catch {
    return undefined;
  }
}

/** "Hubo conflictos" detection after a merge/checkout. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
  return out.split('\n').filter(Boolean);
}

/** Local changes that a checkout would overwrite: the one case switching needs a stash. */
export function isOverwriteError(err: unknown): boolean {
  const text = err instanceof GitError ? err.stderr : String(err);
  return /would be overwritten|commit your changes or stash them/i.test(text);
}

export function fileStem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[A-Za-z0-9]+$/, '') || base;
}
