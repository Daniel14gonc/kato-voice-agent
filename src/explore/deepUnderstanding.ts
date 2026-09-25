import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentProvider } from '../agent/agentProvider';
import type { ToolActivity } from '../agent/agentSession';
import { getConfig } from '../config';

/** One spoken sentence tied to the exact lines it talks about. */
export interface TourSegment {
  text: string;
  range: vscode.Range;
}

export interface TourStop {
  uri: vscode.Uri;
  range: vscode.Range;
  label: string;
  explanation: string;
  segments: TourSegment[];
}

export interface DeepResult {
  overview: string;
  stops: TourStop[];
}

export type TourGranularity = 'block' | 'function' | 'section';

interface RepoNote {
  question: string;
  overview: string;
  date: string;
}

const NOTES_KEY = 'kato.repoNotes';
const MAX_NOTES = 5;
const EXPLORE_TIMEOUT_MS = 4 * 60_000;

/** Where an exploration shows itself while it runs (the panel's agent card). */
export interface ExplorationHooks {
  begin(question: string, provider: string, es: boolean): void;
  activity(activity: ToolActivity): void;
  end(ok: boolean): void;
}

/**
 * Deep understanding: questions that need exploring code that is NOT on
 * screen ("explain the repo", "where does feature X live?") are delegated to
 * the coding agent in read-only mode. The agent returns an overview plus a
 * guided tour of stops. What it learns is cached per workspace so follow-up
 * questions don't re-explore from scratch.
 */
export class DeepUnderstanding {
  constructor(
    private readonly providers: Record<string, AgentProvider>,
    private readonly getSelected: () => { provider: string; model: string },
    private readonly memento: vscode.Memento,
    private readonly log: (message: string) => void,
    private readonly hooks?: ExplorationHooks,
  ) {}

  /** Snapshot line with cached knowledge; empty when nothing is cached. */
  notesLine(): string {
    const notes = this.memento.get<RepoNote[]>(NOTES_KEY, []);
    if (notes.length === 0) {
      return '';
    }
    const body = notes
      .map((n) => `- Q: ${n.question}\n  A: ${n.overview.slice(0, 300)}`)
      .join('\n');
    return `REPO NOTES (from earlier agent explorations of this workspace):\n${body}`;
  }

  /** Spoken name of the agent that will explore ("Claude Code"). */
  agentLabel(): string {
    const name = this.getSelected().provider;
    return name === 'codex' ? 'Codex' : name === 'claude-code' ? 'Claude Code' : name;
  }

  clearNotes(): Thenable<void> {
    return this.memento.update(NOTES_KEY, []);
  }

  async explore(
    question: string,
    language: string | undefined,
    signal: AbortSignal,
    granularity?: TourGranularity,
  ): Promise<DeepResult> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (roots.length === 0) {
      throw new Error('No workspace open');
    }
    const { provider: providerName, model } = this.getSelected();
    const provider = this.providers[providerName];
    if (!provider) {
      throw new Error(`Unknown agent provider: ${providerName}`);
    }

    // Cap the exploration so a stuck agent can't hold the pipeline forever.
    const combined = new AbortController();
    const timer = setTimeout(
      () => combined.abort(new Error('La exploración excedió 4 minutos')),
      EXPLORE_TIMEOUT_MS,
    );
    const forward = () => combined.abort();
    signal.addEventListener('abort', forward, { once: true });

    this.log(`[agent] exploring with ${provider.name}${model ? ` (${model})` : ''}: "${question}"`);
    const started = Date.now();
    this.hooks?.begin(question, providerName, language !== 'en');
    let ok = false;
    try {
      const raw = await provider.runReadOnly({
        prompt: this.buildPrompt(question, language, roots, granularity),
        cwd: roots[0],
        extraDirs: roots.slice(1),
        model: model || undefined,
        signal: combined.signal,
        onProgress: (line) => this.log(`[agent] ${line}`),
        onActivity: (activity) => this.hooks?.activity(activity),
      });
      this.log(`[agent] done in ${Math.round((Date.now() - started) / 1000)}s`);
      const result = await this.parse(raw, roots);
      await this.saveNote(question, result.overview);
      ok = true;
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', forward);
      this.hooks?.end(ok);
    }
  }

  private buildPrompt(
    question: string,
    language: string | undefined,
    roots: string[],
    granularity?: TourGranularity,
  ): string {
    const notes = this.notesLine();
    const lang = language === 'en' ? 'English' : 'Spanish';
    const rootsBlock =
      roots.length > 1
        ? `The workspace has ${roots.length} root folders — explore ALL that are relevant to the question:\n${roots
            .map((r) => `- ${r}`)
            .join('\n')}\n\n`
        : '';
    // Precedence: what the user said by voice > forced setting > agent decides.
    const setting = getConfig().tourGranularity;
    const forced =
      granularity ??
      (setting === 'block' || setting === 'function' || setting === 'section'
        ? (setting as TourGranularity)
        : undefined);
    const RULES: Record<TourGranularity, string> = {
      block:
        '- BLOCK-LEVEL stops: walk through the code line by line — each stop is a single statement or small block ' +
        '(a condition, a loop, a call), and its explanation says exactly what those lines do and why. Up to 12 stops.\n',
      function:
        '- FINE-GRAINED stops: one stop per function/method/class, its line range covering exactly that definition. ' +
        'Never lump several functions into one stop. Each explanation must be SPECIFIC to that function: what it takes, ' +
        'what it does, what it returns or triggers. Up to 12 stops.\n',
      section:
        '- SECTION-LEVEL stops: each stop covers a logical group of related code (a module, a cluster of endpoints, a class), ' +
        'and its explanation summarizes what that group is responsible for. Up to 8 stops.\n',
    };
    const tourRules = forced
      ? RULES[forced]
      : '- Choose the granularity from the SCOPE of the question. Whole-repo or architecture questions → section-level ' +
        'stops (a module or logical group each, up to 8). Questions about one file, one feature or one flow → one stop ' +
        'per function/method with its exact line range and a specific explanation (what it takes, does and returns), up to 12. ' +
        'A single function or tricky algorithm asked in depth → block-level stops walking it line by line.\n';
    return (
      'You are exploring a code repository in READ-ONLY mode to answer a developer question and prepare a guided tour of the relevant code.\n\n' +
      `Question: "${question}"\n\n` +
      rootsBlock +
      (notes ? `${notes}\n\n` : '') +
      'Explore the repository as needed (read files, search). Then reply with ONLY a JSON object — no markdown fences, no text before or after:\n' +
      '{\n' +
      '  "overview": "answer to the question in 2-5 sentences, spoken style (it will be read aloud by TTS: no lists, no code blocks)",\n' +
      '  "stops": [\n' +
      '    {"file": "absolute/path/or/path/relative/to/the/first/root", "line_start": 10, "line_end": 25, "segments": [\n' +
      '      {"text": "one spoken sentence about specific lines", "line_start": 10, "line_end": 14}\n' +
      '    ]}\n' +
      '  ]\n' +
      '}\n' +
      'Tour rules:\n' +
      tourRules +
      '- Order stops as a guided tour: entry point first, then follow the flow (across files and roots when relevant).\n' +
      '- Split each stop into 1-5 segments. Each segment "text" is ONE spoken sentence, and its line range points at ' +
      'EXACTLY the lines that sentence talks about (within the stop). While the sentence is spoken aloud, those lines get ' +
      'highlighted in the editor — precision matters. Together the segments read as one fluent explanation.\n' +
      `Write overview and explanations in ${lang}; keep code identifiers in English.`
    );
  }

  private async parse(raw: string, roots: string[]): Promise<DeepResult> {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`El agente no devolvió JSON: ${raw.slice(0, 200)}`);
    }
    let parsed: { overview?: unknown; stops?: unknown };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (err) {
      throw new Error(`No pude parsear la respuesta del agente: ${String(err)}`);
    }
    const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
    if (!overview) {
      throw new Error('La respuesta del agente no trae overview');
    }
    const stops: TourStop[] = [];
    for (const item of Array.isArray(parsed.stops) ? parsed.stops : []) {
      const stop = await this.validateStop(item, roots);
      if (stop) {
        stops.push(stop);
      }
      if (stops.length >= 12) {
        break;
      }
    }
    return { overview, stops };
  }

  /** Drops stops pointing at files that don't exist; clamps line ranges. */
  private async validateStop(item: any, roots: string[]): Promise<TourStop | undefined> {
    const hasNarration =
      typeof item?.explanation === 'string' ||
      (Array.isArray(item?.segments) && item.segments.some((s: any) => typeof s?.text === 'string'));
    if (!item || typeof item.file !== 'string' || !hasNarration) {
      return undefined;
    }
    // The agent may answer with absolute paths or paths relative to any root.
    const candidates = path.isAbsolute(item.file)
      ? [vscode.Uri.file(item.file)]
      : roots.map((root) => vscode.Uri.joinPath(vscode.Uri.file(root), item.file));
    let doc: vscode.TextDocument | undefined;
    let uri: vscode.Uri | undefined;
    for (const candidate of candidates) {
      try {
        doc = await vscode.workspace.openTextDocument(candidate);
        uri = candidate;
        break;
      } catch {
        // try the next root
      }
    }
    if (!doc || !uri) {
      this.log(`[agent] dropping stop with unknown file: ${item.file}`);
      return undefined;
    }
    const clampRange = (rawStart: unknown, rawEnd: unknown): vscode.Range => {
      const startLine = Math.min(Math.max(0, Number(rawStart ?? 1) - 1), doc.lineCount - 1);
      const endLine = Math.min(Math.max(startLine, Number(rawEnd ?? startLine + 1) - 1), doc.lineCount - 1);
      return new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    };
    const stopRange = clampRange(item.line_start, item.line_end);
    const segments: TourSegment[] = [];
    for (const seg of Array.isArray(item.segments) ? item.segments : []) {
      if (typeof seg?.text !== 'string' || !seg.text.trim()) {
        continue;
      }
      segments.push({
        text: seg.text.trim(),
        range: clampRange(seg.line_start ?? item.line_start, seg.line_end ?? item.line_end),
      });
    }
    if (segments.length === 0) {
      // Older/looser agent output: one segment spanning the whole stop.
      segments.push({ text: String(item.explanation ?? '').trim(), range: stopRange });
    }
    return {
      uri,
      range: stopRange,
      label: `${vscode.workspace.asRelativePath(uri)}:${stopRange.start.line + 1}`,
      explanation: segments.map((s) => s.text).join(' '),
      segments,
    };
  }

  private async saveNote(question: string, overview: string): Promise<void> {
    const notes = this.memento.get<RepoNote[]>(NOTES_KEY, []);
    notes.push({ question, overview, date: new Date().toISOString().slice(0, 10) });
    await this.memento.update(NOTES_KEY, notes.slice(-MAX_NOTES));
  }
}
