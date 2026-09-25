/**
 * Shell commands that only read. In the default permission level every Bash
 * call used to park the agent on a spoken "¿lo apruebo?" — including `ls` and
 * `git status` — so a single task could ask ten times. Commands that provably
 * cannot change anything are approved silently; everything else still asks.
 *
 * Deliberately conservative: any construct we can't reason about (command
 * substitution, redirection to a file, unknown binaries, write flags) falls
 * back to asking.
 */

const READ_ONLY_BINARIES = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'echo', 'printf',
  'which', 'whereis', 'type', 'whoami', 'file', 'stat', 'du', 'df', 'tree', 'sort', 'uniq', 'cut',
  'diff', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'less', 'more', 'nl', 'tr', 'jq',
  'true', 'test', 'uname', 'cd', 'column',
]);

const GIT_READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog',
  'grep', 'reflog', 'ls-tree', 'cat-file', 'merge-base', 'show-ref',
]);

/** Version / listing queries on package managers and runtimes. */
const VERSION_FLAGS = /^(--version|-v|-V|version)$/;

export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (!text) {
    return false;
  }
  // Command substitution and backticks can run anything.
  if (/`|\$\(|<\(/.test(text)) {
    return false;
  }
  // Redirection into a file writes. `2>&1` and `> /dev/null` are harmless.
  const withoutHarmless = text.replace(/\d?>&\d/g, '').replace(/\d?>>?\s*\/dev\/null/g, '');
  if (/>/.test(withoutHarmless)) {
    return false;
  }
  const segments = withoutHarmless.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  return segments.length > 0 && segments.every(isReadOnlySegment);
}

function isReadOnlySegment(segment: string): boolean {
  // Drop env prefixes (FOO=bar cmd) and grouping parens.
  const words = segment
    .replace(/^[(\s]+|[)\s]+$/g, '')
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
    .split(/\s+/)
    .filter(Boolean);
  const [bin, ...args] = words;
  if (!bin) {
    return false;
  }
  const name = bin.split('/').pop() ?? bin;
  switch (name) {
    case 'git': {
      const sub = args.find((arg) => !arg.startsWith('-'));
      if (sub === 'branch') {
        // Listing only: any positional arg or -d/-D/-m creates/deletes/renames.
        return args.slice(1).every((arg) => /^(--list|-a|-r|-v|-vv|--all|--show-current|--remotes)$/.test(arg));
      }
      if (sub === 'remote') {
        return args.slice(1).every((arg) => arg === '-v' || arg === 'show');
      }
      if (sub === 'stash') {
        return args[1] === 'list' || args[1] === 'show';
      }
      return sub !== undefined && GIT_READ_ONLY.has(sub) && !args.some((arg) => arg.startsWith('--output'));
    }
    case 'sed':
      // In-place editing writes.
      return !args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'));
    case 'find':
      return !args.some((arg) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(arg));
    case 'sort':
    case 'tree':
      // -o writes the result to a file.
      return !args.some((arg) => /^-[a-zA-Z]*o/.test(arg) || arg.startsWith('--output'));
    case 'uniq':
      // `uniq in out` writes its second operand.
      return args.filter((arg) => !arg.startsWith('-')).length <= 1;
    case 'awk':
      // awk can shell out with system() or write with print > file.
      return !/system\s*\(|print[^|]*>|\|\s*getline/.test(args.join(' '));
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return args.length === 1 && (VERSION_FLAGS.test(args[0]) || args[0] === 'ls' || args[0] === 'list');
    case 'node':
    case 'python':
    case 'python3':
    case 'go':
    case 'cargo':
    case 'java':
    case 'ruby':
      return args.length === 1 && VERSION_FLAGS.test(args[0]);
    default:
      return READ_ONLY_BINARIES.has(name);
  }
}
