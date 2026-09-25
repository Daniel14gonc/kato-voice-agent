import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface SearchHit {
  uri: vscode.Uri;
  line: number; // 0-based
  column: number; // 0-based
  text: string;
}

const MAX_HITS = 20;

let cachedRgPath: string | undefined;

/**
 * Text search via ripgrep. workspace.findTextInFiles is still a proposed API,
 * so we spawn the rg binary that VS Code/Cursor already ship (falling back to
 * one on PATH). No extra install for the user.
 */
export async function searchCode(query: string, root: string): Promise<SearchHit[]> {
  const rg = findRgPath();
  if (!rg) {
    throw new Error('ripgrep no disponible (ni en VS Code ni en PATH)');
  }
  const args = [
    '--line-number',
    '--column',
    '--no-heading',
    '--color=never',
    '--smart-case',
    '--max-count=3',
    '--max-columns=200',
    `--max-filesize=1M`,
    '--fixed-strings',
    query,
    '.',
  ];
  const output = await run(rg, args, root);
  const hits: SearchHit[] = [];
  for (const line of output.split('\n')) {
    // file:line:column:text — file may contain ':' on Windows; we're on POSIX.
    const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (!match) {
      continue;
    }
    hits.push({
      uri: vscode.Uri.file(path.resolve(root, match[1])),
      line: Number(match[2]) - 1,
      column: Number(match[3]) - 1,
      text: match[4].trim().slice(0, 120),
    });
    if (hits.length >= MAX_HITS) {
      break;
    }
  }
  return hits;
}

function findRgPath(): string | undefined {
  if (cachedRgPath) {
    return cachedRgPath;
  }
  const arch = `${process.platform}-${process.arch}`; // e.g. darwin-arm64
  const candidates = [
    // Modern VS Code ships a universal package with per-arch binaries.
    path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', arch, 'rg'),
    // Cursor (and older VS Code) use the classic layout.
    path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
    path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', 'rg'),
    path.join(vscode.env.appRoot, 'node_modules', 'vscode-ripgrep', 'bin', 'rg'),
    '/opt/homebrew/bin/rg',
    '/usr/local/bin/rg',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedRgPath = candidate;
      return candidate;
    }
  }
  return undefined;
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      // rg exits 1 when there are no matches — that's a valid empty result.
      if (code === 0 || code === 1) {
        resolve(stdout);
      } else {
        reject(new Error(`ripgrep exited ${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}
