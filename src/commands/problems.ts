import * as vscode from 'vscode';
import type { Referent } from '../conversation/referents';

const MAX_LISTED = 20;
/** What goes to the agent: enough to fix, not a wall of duplicates. */
const MAX_FOR_AGENT = 40;

interface Problem {
  uri: vscode.Uri;
  diagnostic: vscode.Diagnostic;
}

/**
 * The Problems panel, by voice: "¿cuántos errores hay?", "llévame al
 * primero", "arréglalos". Reading is deterministic (VS Code already knows the
 * errors); fixing is always the coding agent's job.
 */
export class ProblemsService {
  /** Errors first, the active file first among equals, then by file and line. */
  private collect(onlyErrors: boolean): Problem[] {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    const problems: Problem[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (/\/(node_modules|dist|out|build|\.venv|venv)\//.test(uri.path) || uri.scheme !== 'file') {
        continue;
      }
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity === vscode.DiagnosticSeverity.Error ||
          (!onlyErrors && diagnostic.severity === vscode.DiagnosticSeverity.Warning)) {
          problems.push({ uri, diagnostic });
        }
      }
    }
    return problems.sort(
      (a, b) =>
        a.diagnostic.severity - b.diagnostic.severity ||
        Number(b.uri.toString() === active) - Number(a.uri.toString() === active) ||
        a.uri.path.localeCompare(b.uri.path) ||
        a.diagnostic.range.start.line - b.diagnostic.range.start.line,
    );
  }

  private counts(): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    for (const problem of this.collect(false)) {
      if (problem.diagnostic.severity === vscode.DiagnosticSeverity.Error) {
        errors++;
      } else {
        warnings++;
      }
    }
    return { errors, warnings };
  }

  /** Snapshot line: lets the router tell "arréglalos" apart from a vague "fix it". */
  statusLine(): string {
    const { errors, warnings } = this.counts();
    if (errors + warnings === 0) {
      return '';
    }
    const files = [...new Set(this.collect(true).map((p) => fileStem(p.uri)))].slice(0, 4).join(', ');
    return (
      `PROBLEMS: ${errors} error(s), ${warnings} warning(s)${files ? ` — errors in ${files}` : ''}. ` +
      '"¿qué errores hay?" → problems summary; "arréglalos / fix the errors" → problems fix.'
    );
  }

  /**
   * Spoken overview plus the list as referents, so "la siguiente" walks the
   * errors one by one. `undefined` referents when there is nothing to show.
   */
  summary(es: boolean): { speech: string; referents?: Array<Omit<Referent, 'id'>> } {
    const { errors, warnings } = this.counts();
    if (errors + warnings === 0) {
      return { speech: es ? 'No hay errores ni warnings. Todo limpio.' : 'No errors or warnings. All clean.' };
    }
    const listed = this.collect(errors === 0 ? false : true).slice(0, MAX_LISTED);
    const byFile = new Map<string, number>();
    for (const problem of listed) {
      byFile.set(fileStem(problem.uri), (byFile.get(fileStem(problem.uri)) ?? 0) + 1);
    }
    const files = [...byFile.entries()]
      .slice(0, 3)
      .map(([file, count]) => (count > 1 ? `${count} ${es ? 'en' : 'in'} ${file}` : `${es ? 'uno en' : 'one in'} ${file}`))
      .join(', ');
    const what =
      errors > 0
        ? es
          ? `Tienes ${errors} error${errors === 1 ? '' : 'es'}${warnings ? ` y ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`
          : `You have ${errors} error${errors === 1 ? '' : 's'}${warnings ? ` and ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`
        : es
          ? `No hay errores, solo ${warnings} warning${warnings === 1 ? '' : 's'}`
          : `No errors, just ${warnings} warning${warnings === 1 ? '' : 's'}`;
    const first = listed[0];
    const speech =
      `${what}: ${files}. ` +
      (es
        ? `Te llevé al primero: ${spokenMessage(first.diagnostic.message)}. Di "la siguiente" para pasar al otro, o "arréglalos".`
        : `I took you to the first one: ${spokenMessage(first.diagnostic.message)}. Say "next" for the next one, or "fix them".`);
    return {
      speech,
      referents: listed.map((problem) => ({
        label: `${vscode.workspace.asRelativePath(problem.uri)}:${problem.diagnostic.range.start.line + 1} — ${problem.diagnostic.message.split('\n')[0].slice(0, 100)}`,
        uri: problem.uri,
        range: problem.diagnostic.range,
        spoken: `${spokenMessage(problem.diagnostic.message)}, ${es ? 'en' : 'in'} ${fileStem(problem.uri)}`,
      })),
    };
  }

  /** The task handed to the agent for "arréglalos"; undefined when there is nothing to fix. */
  fixInstruction(userWords: string, scope: 'file' | 'workspace'): string | undefined {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    let problems = this.collect(true);
    if (scope === 'file' && active) {
      problems = problems.filter((p) => p.uri.toString() === active);
    }
    if (problems.length === 0) {
      return undefined;
    }
    const lines = problems.slice(0, MAX_FOR_AGENT).map((p) => {
      const source = p.diagnostic.source ? ` [${p.diagnostic.source}${p.diagnostic.code ? ` ${codeOf(p.diagnostic)}` : ''}]` : '';
      return `- ${vscode.workspace.asRelativePath(p.uri)}:${p.diagnostic.range.start.line + 1}:${p.diagnostic.range.start.character + 1}${source} ${p.diagnostic.message.replace(/\s+/g, ' ')}`;
    });
    const more = problems.length > MAX_FOR_AGENT ? `\n…and ${problems.length - MAX_FOR_AGENT} more.` : '';
    return (
      `${userWords}\n\nFix these errors reported by VS Code's Problems panel (language servers / linters). ` +
      'Fix the root cause rather than silencing them (no ts-ignore, no disabling rules) unless that is clearly right. ' +
      `When done, make sure the project still type-checks/builds if there is a quick way to check.\n${lines.join('\n')}${more}`
    );
  }

  counted(scope: 'file' | 'workspace'): number {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    const errors = this.collect(true);
    return scope === 'file' ? errors.filter((p) => p.uri.toString() === active).length : errors.length;
  }
}

function codeOf(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code;
  return typeof code === 'object' && code !== null ? String(code.value) : String(code ?? '');
}

function fileStem(uri: vscode.Uri): string {
  const base = uri.path.split('/').pop() ?? uri.path;
  return base.replace(/\.[A-Za-z0-9]+$/, '') || base;
}

/**
 * Compiler messages are written for eyes: quotes, type signatures, trailing
 * codes. Keep the first sentence, drop the quote marks, cap the length.
 */
function spokenMessage(message: string): string {
  const first = message.split('\n')[0].split(/(?<=\.)\s/)[0];
  const clean = first.replace(/['"`‘’“”]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > 110 ? `${clean.slice(0, 110)}…` : clean;
}
