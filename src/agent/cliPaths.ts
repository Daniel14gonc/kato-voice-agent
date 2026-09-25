import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where the agent CLIs live. Kato drives the CLI the user already installed
 * and logged into, instead of the per-platform binaries the SDKs can bundle:
 * those are ~300 MB each and single-platform, which made the packaged
 * extension ~560 MB and Apple-Silicon-only.
 */

/** PATH plus the usual install dirs — the extension host's PATH is often stripped when VS Code starts from the Dock. */
export function findBinary(name: string, extraDirs: string[] = []): string | undefined {
  const exe = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  const dirs = [
    ...extraDirs,
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ];
  for (const dir of dirs) {
    for (const file of exe) {
      const candidate = dir ? path.join(dir, file) : '';
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** `kato.agent.cliPath` wins; then the usual places Claude Code installs itself. */
export function resolveClaudeCli(configured?: string): string | undefined {
  if (configured && existsSync(configured)) {
    return configured;
  }
  return findBinary('claude', [path.join(os.homedir(), '.claude', 'local')]);
}

export function resolveCodexCli(): string | undefined {
  return findBinary('codex');
}

export const CLAUDE_MISSING =
  "Couldn't find Claude Code. Install it (npm i -g @anthropic-ai/claude-code) and run \"claude\" once to sign in, " +
  'or set kato.agent.cliPath.';
export const CODEX_MISSING = "Couldn't find Codex. Install it (npm i -g @openai/codex) and run \"codex login\".";
