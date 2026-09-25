import * as vscode from 'vscode';
import type { AgentManager } from '../agent/agentManager';
import type { AgentMode } from '../agent/agentSession';
import {
  commit,
  getFullDiff,
  getRepository,
  stageAll,
  summarizeChanges,
  switchBranch,
} from '../commands/git';
import type { TestRunner } from '../commands/testRunner';
import { getConfig } from '../config';
import type { ContextSnapshot } from '../context/contextEngine';
import type { Referent, ReferentStore } from '../conversation/referents';
import type { ChatMessage, LlmProvider } from '../llm/llmProvider';
import { findDefinition, findReferences, findWorkspaceSymbols, goTo, locationLabel, previewLine } from '../explore/lspQueries';
import { searchCode, type SearchHit } from '../explore/search';
import type { DebugController } from '../explore/debugController';
import type { TourGranularity } from '../explore/deepUnderstanding';
import type { SpokenPart, TourAction, TourEngine } from '../explore/tourEngine';
import type { Intent } from './intentRouter';

/**
 * Result of executing an intent: template speech (deterministic tools — no
 * LLM in the path, so IDE commands stay fast), a message list for the
 * explainer LLM to stream into TTS, or a deep exploration the pipeline runs
 * asynchronously with a spoken ack.
 */
export type ExecutionResult =
  | { kind: 'speech'; text: string; parts?: SpokenPart[] }
  | { kind: 'llm'; messages: ChatMessage[] }
  | { kind: 'deep'; question: string; granularity?: TourGranularity };

const ANSWER_SYSTEM_PROMPT =
  'You are Kato, a voice assistant for programmers inside VS Code. ' +
  'You can navigate code, search, and explain what the user is looking at; you never generate or edit code. ' +
  'A SNAPSHOT of what the user currently sees may be provided — use it when relevant. ' +
  'You only know the code in the snapshot. If the question is about this project\'s code and the snapshot does not ' +
  'contain the answer, do NOT guess: say in one sentence that you can have the coding agent explore it, e.g. ' +
  '"Eso no lo veo en pantalla; ¿quieres que el agente lo explore?". ' +
  'Keep answers to 1-3 short sentences. Your answer is read aloud by TTS: no markdown, no lists, no code blocks.';

const EXPLAIN_SYSTEM_PROMPT =
  'You are Kato, a voice assistant for programmers inside VS Code. Explain the given code clearly and briefly, ' +
  'like a colleague talking over your shoulder: what it does and anything notable. 2-4 short sentences max. ' +
  'Spoken aloud by TTS: no markdown, no lists, no code blocks; say identifiers naturally.';

export class IntentExecutor {
  /** A destructive action waiting for a spoken yes/no. */
  private pending: { description: string; run: () => Promise<string> } | undefined;

  constructor(
    private readonly referents: ReferentStore,
    private readonly tour: TourEngine,
    private readonly llm: LlmProvider,
    private readonly agents: AgentManager,
    private readonly tests: TestRunner,
    private readonly debug: DebugController,
    /** Opens the panel composer so the user can paste a value. */
    private readonly requestTypedInput: (placeholder: string, question: string) => void,
    /** Shows one line in the panel's activity history (lists go here, not to TTS). */
    private readonly showActivity: (line: string) => void = () => {},
  ) {}

  /** Renders a referent list in the panel so speech can stay short. */
  private showList(refs: Referent[]): void {
    for (const ref of refs) {
      this.showActivity(`${ref.id}: ${ref.label}`);
    }
  }

  /** Snapshot line so the router knows a yes/no is expected. */
  pendingConfirmationLine(): string {
    return this.pending
      ? `PENDING CONFIRMATION: ${this.pending.description} — a yes/no answer means confirm_action.`
      : '';
  }

  async execute(
    intent: Intent,
    snapshot: ContextSnapshot,
    history: ChatMessage[],
    language: string | undefined,
    signal: AbortSignal,
    /** What the user actually said — needed when a "yes" has to become steering. */
    transcript = '',
  ): Promise<ExecutionResult> {
    const es = language !== 'en'; // default to Spanish, the user's primary language
    const needsWorkspace = [
      'nav_goto_symbol',
      'find_references',
      'search_code',
      'debug_control',
      'find_feature',
      'explain_deep',
      'agent_delegate',
      'git_diff',
      'git_stage',
      'git_branch',
      'git_commit',
      'run_tests',
    ].includes(intent.tool);
    if (needsWorkspace && !snapshot.hasWorkspace) {
      return speech(
        es
          ? 'No tienes ningún proyecto abierto en VS Code. Abre una carpeta y lo intentamos de nuevo.'
          : "You don't have a project open in VS Code. Open a folder and we'll try again.",
      );
    }

    switch (intent.tool) {
      case 'nav_goto_ref':
        return this.gotoRef(String(intent.args.ref_id ?? ''), es);
      case 'nav_cycle':
        return this.cycle(intent.args.direction === 'prev' ? 'prev' : 'next', es);
      case 'nav_goto_symbol':
        return this.gotoSymbol(String(intent.args.name ?? ''), es);
      case 'find_references':
        return this.references(intent.args.target == null ? undefined : String(intent.args.target), es);
      case 'search_code':
        return this.search(String(intent.args.query ?? ''), es);
      case 'find_feature':
        return this.findFeature(
          String(intent.args.question ?? ''),
          Array.isArray(intent.args.keywords) ? intent.args.keywords.map(String) : [],
          language,
          es,
          signal,
        );
      case 'explain_quick':
        return this.explainQuick(
          String(intent.args.question ?? ''),
          intent.args.ref_id == null ? undefined : String(intent.args.ref_id),
          snapshot,
          es,
        );
      case 'explain_deep': {
        const g = intent.args.granularity;
        return {
          kind: 'deep',
          question: String(intent.args.question ?? ''),
          granularity: g === 'block' || g === 'function' || g === 'section' ? g : undefined,
        };
      }
      case 'debug_control': {
        const action = String(intent.args.action ?? '');
        const target = intent.args.target == null ? undefined : String(intent.args.target);
        const line = typeof intent.args.line === 'number' ? intent.args.line : undefined;
        switch (action) {
          case 'start':
            return speech(await this.debug.start(target, es));
          case 'set_breakpoint':
            return speech(await this.debug.setBreakpoint(target, line, es));
          case 'remove_breakpoints':
            return speech(this.debug.removeBreakpoints(es));
          case 'step_over':
          case 'step_into':
          case 'step_out':
          case 'continue':
            return speech(await this.debug.step(action, es));
          case 'evaluate':
            return speech(await this.debug.evaluate(target ?? '', es));
          case 'stop':
            return speech(await this.debug.stopSession(es));
          default:
            return speech(es ? 'No entendí qué hacer con el debugger.' : "I didn't get what to do with the debugger.");
        }
      }
      case 'tour_control': {
        const parts = await this.tour.control(String(intent.args.action ?? 'next') as TourAction, es);
        return { kind: 'speech', text: parts.map((p) => p.text).join(' '), parts };
      }
      case 'agent_delegate': {
        const mode = intent.args.mode;
        return speech(
          this.agents.delegate(
            String(intent.args.instruction ?? ''),
            mode === 'ask' || mode === 'plan' || mode === 'agent' || mode === 'auto'
              ? (mode as AgentMode)
              : undefined,
            snapshot.text,
            es,
          ),
        );
      }
      case 'agent_control':
        switch (String(intent.args.action ?? 'status')) {
          case 'stop':
            return speech(await this.agents.stop(es));
          case 'approve':
            return speech(this.agents.approve(es, transcript));
          case 'deny':
            return speech(this.agents.deny(es, transcript));
          case 'continue':
            return speech(await this.agents.continuePlan(es));
          case 'set_mode':
            // The user's own words go to the manager, which matches them
            // against the levels the live agent actually has.
            return speech(
              await this.agents.setPermissionLevel(
                intent.args.mode == null ? transcript : String(intent.args.mode),
                es,
              ),
            );
          case 'list_modes':
            return speech(this.agents.listModes(es));
          case 'status':
          default:
            return speech(this.agents.status(es));
        }
      case 'git_diff':
        return this.gitDiff(intent.args.explain === true, language, es);
      case 'git_stage':
        return this.gitStage(es);
      case 'git_branch':
        return this.gitBranch(String(intent.args.name ?? ''), intent.args.create === true, es);
      case 'git_commit':
        return this.gitCommit(
          intent.args.message == null ? undefined : String(intent.args.message),
          signal,
          es,
        );
      case 'run_tests':
        return speech(await this.tests.start(es));
      case 'confirm_action': {
        const pending = this.pending;
        this.pending = undefined;
        if (!pending) {
          // A misrouted yes/no used to die here while the agent sat blocked on
          // a permission request — it timed out three times in one real
          // session. Hand it to the agent instead of swallowing it.
          if (this.agents.active) {
            return speech(
              intent.args.yes === false
                ? this.agents.deny(es, transcript)
                : this.agents.approve(es, transcript),
            );
          }
          return speech(es ? 'No tengo nada pendiente de confirmar.' : 'I have nothing pending confirmation.');
        }
        if (intent.args.yes === false) {
          return speech(es ? 'Cancelado, no hice nada.' : 'Cancelled — I did nothing.');
        }
        try {
          return speech(await pending.run());
        } catch (err) {
          return speech(
            es ? `No pude completarlo: ${errorText(err)}` : `I couldn't complete it: ${errorText(err)}`,
          );
        }
      }
      case 'ask_input': {
        const question = String(
          intent.args.question ?? (es ? '¿Me lo pegas en el panel?' : 'Could you paste it in the panel?'),
        );
        this.requestTypedInput(String(intent.args.placeholder ?? ''), question);
        return speech(question);
      }
      case 'ask_clarification':
        return speech(String(intent.args.question ?? (es ? '¿Puedes repetirlo?' : 'Can you repeat that?')));
      case 'answer':
      default:
        return {
          kind: 'llm',
          messages: [
            { role: 'system', content: ANSWER_SYSTEM_PROMPT },
            { role: 'system', content: `SNAPSHOT of what the user sees now:\n${snapshot.text}` },
            ...history,
          ],
        };
    }
  }

  private async gotoRef(refId: string, es: boolean): Promise<ExecutionResult> {
    const ref = this.referents.get(refId);
    if (!ref) {
      return speech(es ? 'No tengo ese elemento en la lista.' : "I don't have that item on the list.");
    }
    await goTo(ref.uri, ref.range);
    this.referents.markCurrent(ref.id);
    return speech(es ? `Listo: ${refSpeech(ref, es)}.` : `Done: ${refSpeech(ref, es)}.`);
  }

  /** "la otra", "la siguiente", "the previous one" — walk the last result list. */
  private async cycle(direction: 'next' | 'prev', es: boolean): Promise<ExecutionResult> {
    const step = this.referents.step(direction);
    if (!step) {
      return speech(es ? 'No tengo una lista de resultados que recorrer.' : "I don't have a result list to walk through.");
    }
    await goTo(step.ref.uri, step.ref.range);
    const position = `${step.index + 1} ${es ? 'de' : 'of'} ${step.total}`;
    return speech(`${position}: ${refSpeech(step.ref, es)}.`);
  }

  /**
   * "Llévame a la función X". This used to jump only when the LSP returned a
   * single hit or the first hit matched exactly; otherwise it read out "I found
   * 5 symbols: 1, foo.ts line 12; 2, …" — hopeless by ear. Now it ranks the
   * candidates, goes to the best one, and mentions the others in one clause.
   */
  private async gotoSymbol(name: string, es: boolean): Promise<ExecutionResult> {
    // "shopping_cart.py" or "src/foo" is a file, not a symbol — LSP symbol
    // providers don't index file names, so go straight to the file lookup.
    if (/[./\\]/.test(name.trim())) {
      const opened = await this.openFileByName(name, es);
      if (opened) {
        return opened;
      }
    }
    const ranked = rankSymbols(await findWorkspaceSymbols(name), name);
    if (ranked.length === 0) {
      // Not a symbol either — maybe a file said without its extension
      // ("open voice pipeline").
      const opened = await this.openFileByName(name, es);
      if (opened) {
        return opened;
      }
      return speech(
        es
          ? `No encontré ninguna función ni archivo llamado ${name}.`
          : `I couldn't find a function or file called ${name}.`,
      );
    }
    const best = ranked[0];
    await goTo(best.symbol.location.uri, best.symbol.location.range);
    const refs = this.referents.setResults(
      ranked.slice(0, 8).map(({ symbol }) => symbolToReferent(symbol, es)),
      0,
    );
    if (refs.length > 1) {
      this.showList(refs);
    }
    const where = `${best.symbol.name}, ${es ? 'en' : 'in'} ${fileStem(best.symbol.location.uri)}`;
    // Only equally good matches are worth mentioning; fuzzy tails are noise.
    const alternatives = ranked.slice(1, 8).filter((candidate) => candidate.score <= best.score + 1).length;
    const exact = best.symbol.name.toLowerCase() === normalizeSymbolQuery(name);
    let text = exact
      ? es
        ? `Listo, ${where}.`
        : `Done — ${where}.`
      : es
        ? `No hay ninguna que se llame exactamente ${name}; te llevé a ${where}.`
        : `Nothing is called exactly ${name}; I took you to ${where}.`;
    if (alternatives > 0) {
      text += es
        ? ` Hay ${alternatives === 1 ? 'otra parecida' : `${alternatives} más parecidas`}; di "la otra" si no era esa.`
        : ` There ${alternatives === 1 ? 'is one more like it' : `are ${alternatives} more like it`}; say "the other one" if that wasn't it.`;
    }
    return speech(text);
  }

  /**
   * Opens a file by (spoken) name. Transcripts render names loosely —
   * "shopping cart dot p y", "voicePipeline" — so several spelling variants
   * are tried and the best match by basename wins. Undefined when no file
   * matches, so the caller can fall through to its own miss message.
   */
  private async openFileByName(name: string, es: boolean): Promise<ExecutionResult | undefined> {
    const cleaned = name.trim().replace(/\\/g, '/').toLowerCase();
    const said = cleaned.split('/').pop() ?? cleaned;
    const stem = said.replace(/\.[a-z0-9]+$/, '');
    const variants = new Set(
      [said, stem, stem.replace(/\s+/g, '_'), stem.replace(/\s+/g, '-'), stem.replace(/\s+/g, '')].filter(Boolean),
    );
    const matches = new Map<string, vscode.Uri>();
    for (const variant of variants) {
      const found = await vscode.workspace.findFiles(`**/*${variant}*`, '**/node_modules/**', 20);
      for (const uri of found) {
        matches.set(uri.toString(), uri);
      }
    }
    if (matches.size === 0) {
      return undefined;
    }
    // Exact basename beats prefix beats substring; a test_/spec copy must
    // never outrank the file the user actually named.
    const scored = [...matches.values()]
      .map((uri) => {
        const base = uri.path.split('/').pop()!.toLowerCase();
        const baseStem = base.replace(/\.[a-z0-9]+$/, '');
        const score =
          base === said || baseStem === stem ? 0 : base.startsWith(stem) || baseStem.startsWith(stem) ? 1 : 2;
        return { uri, base, score };
      })
      .sort((a, b) => a.score - b.score || a.base.length - b.base.length);
    const best = scored[0];
    await goTo(best.uri, new vscode.Range(0, 0, 0, 0));
    if (scored.length > 1) {
      const refs = this.referents.setResults(
        scored.slice(0, 8).map(({ uri }) => ({
          label: vscode.workspace.asRelativePath(uri),
          uri,
          range: new vscode.Range(0, 0, 0, 0),
          spoken: fileStem(uri),
        })),
        0,
      );
      this.showList(refs);
    }
    return speech(es ? `Listo, abrí ${fileStem(best.uri)}.` : `Done — I opened ${fileStem(best.uri)}.`);
  }

  private async references(target: string | undefined, es: boolean): Promise<ExecutionResult> {
    let uri: vscode.Uri | undefined;
    let position: vscode.Position | undefined;
    let subject = target;

    if (target && this.referents.get(target)) {
      const ref = this.referents.get(target) as Referent;
      uri = ref.uri;
      position = ref.range.start;
      subject = ref.label;
    } else if (target) {
      const symbols = await findWorkspaceSymbols(target);
      if (symbols.length > 0) {
        uri = symbols[0].location.uri;
        position = symbols[0].location.range.start;
        subject = symbols[0].name;
      }
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        uri = editor.document.uri;
        position = editor.selection.active;
        subject = es ? 'el símbolo bajo el cursor' : 'the symbol under the cursor';
      }
    }
    if (!uri || !position) {
      return speech(
        es ? `No encontré ${target ?? 'un símbolo bajo el cursor'}.` : `I couldn't find ${target ?? 'a symbol under the cursor'}.`,
      );
    }
    // References on a name's declaration line can be offset; nudge to the definition first.
    const defs = await findDefinition(uri, position);
    if (defs.length > 0) {
      uri = defs[0].uri;
      position = defs[0].range.start;
    }
    const locations = (await findReferences(uri, position)).slice(0, 12);
    if (locations.length === 0) {
      return speech(es ? `No encontré referencias de ${subject}.` : `I found no references to ${subject}.`);
    }
    const refs = this.referents.setResults(
      await Promise.all(
        locations.map(async (loc) => ({
          label: locationLabel(loc.uri, loc.range),
          uri: loc.uri,
          range: loc.range,
          preview: await previewLine(loc.uri, loc.range.start.line),
          spoken: fileStem(loc.uri),
        })),
      ),
      0,
    );
    this.showList(refs);
    await goTo(refs[0].uri, refs[0].range);
    const count =
      refs.length === 1
        ? es
          ? `Solo un lugar usa ${subject}`
          : `Only one place uses ${subject}`
        : es
          ? `${refs.length} lugares usan ${subject}`
          : `${refs.length} places use ${subject}`;
    return speech(listSpeech(refs, count, es, true));
  }

  private async search(query: string, es: boolean): Promise<ExecutionResult> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return speech(es ? 'No hay proyecto abierto donde buscar.' : 'There is no open project to search in.');
    }
    let hits;
    try {
      // Search every root of the workspace, not just the first.
      const perRoot = await Promise.all(folders.map((f) => searchCode(query, f.uri.fsPath)));
      hits = perRoot.flat().slice(0, 20);
    } catch (err) {
      // A broken search should apologize, not kill the turn.
      return speech(
        es ? `No pude buscar: ${String(err instanceof Error ? err.message : err)}` : `Search failed: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
    if (hits.length === 0) {
      return speech(es ? `No encontré nada con ${query}.` : `I found nothing for ${query}.`);
    }
    const refs = this.referents.setResults(
      hits.map((hit) => ({
        label: `${vscode.workspace.asRelativePath(hit.uri)}:${hit.line + 1}`,
        uri: hit.uri,
        range: new vscode.Range(hit.line, hit.column, hit.line, hit.column + query.length),
        preview: hit.text,
        spoken: fileStem(hit.uri),
      })),
      0,
    );
    this.showList(refs);
    // Open the first hit right away — "search X" almost always means "show me".
    await goTo(refs[0].uri, refs[0].range);
    return speech(
      listSpeech(refs, es ? `${refs.length} resultados para ${query}` : `${refs.length} results for ${query}`, es, true),
    );
  }

  /**
   * Semantic locate: several keyword searches, then a fast LLM picks which hit
   * actually answers "where is X implemented?" and explains what's there.
   */
  private async findFeature(
    question: string,
    keywords: string[],
    language: string | undefined,
    es: boolean,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    const addHit = (hit: SearchHit) => {
      const key = `${hit.uri.toString()}:${hit.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(hit);
      }
    };
    for (const keyword of keywords.slice(0, 5)) {
      // LSP symbols first: for identifiers they beat raw text matches.
      try {
        for (const s of (await findWorkspaceSymbols(keyword)).slice(0, 3)) {
          addHit({
            uri: s.location.uri,
            line: s.location.range.start.line,
            column: s.location.range.start.character,
            text: `${vscode.SymbolKind[s.kind].toLowerCase()} ${s.name}`,
          });
        }
      } catch {
        // no symbol provider — text search still covers it
      }
      for (const folder of folders) {
        try {
          for (const hit of await searchCode(keyword, folder.uri.fsPath)) {
            addHit(hit);
          }
        } catch {
          // rg unavailable for this folder — other folders may still work
        }
      }
    }
    if (hits.length === 0) {
      return speech(
        es
          ? 'No encontré nada relacionado con eso en el workspace. Puedo explorarlo a fondo con el agente si quieres.'
          : "I found nothing related in the workspace. I can explore deeper with the agent if you want.",
      );
    }

    const top = hits.slice(0, 15);
    const listing = top
      .map((h, i) => `${i + 1}. ${vscode.workspace.asRelativePath(h.uri)}:${h.line + 1} — ${h.text}`)
      .join('\n');
    let choiceIndex = 0;
    let spoken: string | undefined;
    try {
      let raw = '';
      await this.llm.streamChat({
        model: getConfig().routerModel,
        messages: [
          {
            role: 'system',
            content:
              'You locate code for a voice assistant. Given a question and candidate locations, reply with ONLY a JSON object ' +
              '{"best": <1-based index>, "spoken": "<1-2 spoken-style sentences: what is at that location and how it answers the question; no markdown>"}.',
          },
          {
            role: 'user',
            content: `Question: ${question}\n\nCandidate locations:\n${listing}\n\nWrite "spoken" in ${
              language === 'en' ? 'English' : 'Spanish'
            }.`,
          },
        ],
        signal,
        onDelta: (d) => (raw += d),
      });
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const best = Number(parsed.best);
      if (best >= 1 && best <= top.length) {
        choiceIndex = best - 1;
      }
      spoken = typeof parsed.spoken === 'string' ? parsed.spoken : undefined;
    } catch {
      // LLM pick failed — fall back to plain search-list behavior below.
    }

    // Chosen hit first so "el primero" and the referent list match the speech.
    const ordered = [top[choiceIndex], ...top.filter((_, i) => i !== choiceIndex)];
    const refs = this.referents.setResults(
      ordered.map((hit) => ({
        label: `${vscode.workspace.asRelativePath(hit.uri)}:${hit.line + 1}`,
        uri: hit.uri,
        range: new vscode.Range(hit.line, hit.column, hit.line, hit.column),
        preview: hit.text,
        spoken: fileStem(hit.uri),
      })),
      0,
    );
    await goTo(refs[0].uri, refs[0].range);
    if (spoken) {
      return speech(spoken);
    }
    return speech(listSpeech(refs, es ? `${refs.length} lugares posibles` : `${refs.length} possible places`, es, true));
  }

  private async gitDiff(
    explain: boolean,
    language: string | undefined,
    es: boolean,
  ): Promise<ExecutionResult> {
    const repo = await getRepository();
    if (!repo) {
      return speech(es ? 'Este proyecto no es un repositorio git.' : "This project isn't a git repository.");
    }
    const changes = summarizeChanges(repo);
    const total = changes.staged.length + changes.unstaged.length;
    if (total === 0) {
      return speech(es ? 'No tienes cambios sin commitear.' : 'You have no uncommitted changes.');
    }
    // Show the changes where the user expects to see them.
    void vscode.commands.executeCommand('workbench.view.scm');
    if (!explain) {
      const names = [...changes.staged, ...changes.unstaged].slice(0, 4).join(', ');
      return speech(
        es
          ? `${total} archivos con cambios en ${changes.branch}: ${names}. Los tienes en el panel de control de código.`
          : `${total} changed files on ${changes.branch}: ${names}. They're in the source control panel.`,
      );
    }
    const diff = await getFullDiff(repo);
    return {
      kind: 'llm',
      messages: [
        {
          role: 'system',
          content:
            'You explain a git diff for a voice assistant: what changed and why it matters, grouped by intent, ' +
            'in 2-4 short spoken sentences. No markdown, no lists, no code blocks.',
        },
        {
          role: 'user',
          content: `Branch ${changes.branch}. Diff:\n${diff}\n\nAnswer in ${
            language === 'en' ? 'English' : 'Spanish'
          }.`,
        },
      ],
    };
  }

  private async gitStage(es: boolean): Promise<ExecutionResult> {
    const repo = await getRepository();
    if (!repo) {
      return speech(es ? 'Este proyecto no es un repositorio git.' : "This project isn't a git repository.");
    }
    const count = await stageAll(repo);
    if (count === 0) {
      return speech(es ? 'No había cambios que agregar.' : 'There was nothing to stage.');
    }
    return speech(
      es ? `Listo, agregué ${count} archivos al stage.` : `Done — staged ${count} files.`,
    );
  }

  private async gitBranch(name: string, create: boolean, es: boolean): Promise<ExecutionResult> {
    const repo = await getRepository();
    if (!repo) {
      return speech(es ? 'Este proyecto no es un repositorio git.' : "This project isn't a git repository.");
    }
    if (!name.trim()) {
      return speech(es ? '¿Cómo se llama la rama?' : "What's the branch name?");
    }
    try {
      const outcome = await switchBranch(repo, name.trim(), create);
      return speech(
        outcome === 'created'
          ? es
            ? `Listo, creé la rama ${name} y me cambié a ella.`
            : `Done — created branch ${name} and switched to it.`
          : es
            ? `Listo, estás en la rama ${name}.`
            : `Done — you're on branch ${name}.`,
      );
    } catch (err) {
      return speech(
        es ? `No pude cambiar de rama: ${errorText(err)}` : `I couldn't switch branches: ${errorText(err)}`,
      );
    }
  }

  /** Commits are destructive: build the message, then ask out loud first. */
  private async gitCommit(
    message: string | undefined,
    signal: AbortSignal,
    es: boolean,
  ): Promise<ExecutionResult> {
    const repo = await getRepository();
    if (!repo) {
      return speech(es ? 'Este proyecto no es un repositorio git.' : "This project isn't a git repository.");
    }
    const changes = summarizeChanges(repo);
    if (changes.staged.length + changes.unstaged.length === 0) {
      return speech(es ? 'No hay cambios para commitear.' : 'There are no changes to commit.');
    }
    const finalMessage = message?.trim() || (await this.generateCommitMessage(repo, signal, es));
    this.pending = {
      description: `commit on ${changes.branch} with message "${finalMessage}"`,
      run: async () => {
        await commit(repo, finalMessage);
        return es ? `Hecho, commit en ${changes.branch}.` : `Done — committed on ${changes.branch}.`;
      },
    };
    return speech(
      es
        ? `Voy a commitear con el mensaje: ${finalMessage}. ¿Lo confirmo?`
        : `I'll commit with the message: ${finalMessage}. Should I go ahead?`,
    );
  }

  private async generateCommitMessage(
    repo: Awaited<ReturnType<typeof getRepository>> & object,
    signal: AbortSignal,
    es: boolean,
  ): Promise<string> {
    try {
      const diff = await getFullDiff(repo);
      let text = '';
      await this.llm.streamChat({
        model: getConfig().routerModel,
        messages: [
          {
            role: 'system',
            content:
              'Write a single-line conventional commit message (max 72 chars) for the given diff. ' +
              'Reply with the message only — no quotes, no explanation.',
          },
          { role: 'user', content: diff.slice(0, 8000) },
        ],
        signal,
        onDelta: (delta) => (text += delta),
      });
      const line = text.trim().split('\n')[0].replace(/^["'`]|["'`]$/g, '');
      return line || (es ? 'actualiza el código' : 'update code');
    } catch {
      return es ? 'actualiza el código' : 'update code';
    }
  }

  private async explainQuick(
    question: string,
    refId: string | undefined,
    snapshot: ContextSnapshot,
    es: boolean,
  ): Promise<ExecutionResult> {
    let code: string | undefined;
    let label: string | undefined;
    const ref = refId ? this.referents.get(refId) : undefined;
    if (ref) {
      code = await readAround(ref.uri, ref.range);
      label = ref.label;
      await goTo(ref.uri, ref.range);
    } else if (snapshot.selectionText) {
      code = snapshot.selectionText;
      label = `selection in ${snapshot.activeFile}`;
    } else if (snapshot.visibleText) {
      code = snapshot.visibleText;
      label = `visible code in ${snapshot.activeFile}`;
    }
    if (!code) {
      return speech(
        es
          ? 'No veo ningún código que explicar. Abre un archivo o selecciona algo.'
          : "I don't see any code to explain. Open a file or select something.",
      );
    }
    return {
      kind: 'llm',
      messages: [
        { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Code (${label}):\n\`\`\`\n${code}\n\`\`\`\n\nQuestion: ${question || 'Explain this code.'}`,
        },
      ],
    };
  }
}

function speech(text: string): ExecutionResult {
  return { kind: 'speech', text };
}

function errorText(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 160);
}

/**
 * "src/voice/voicePipeline.ts" → "voicePipeline". By ear, the file name is
 * all that helps: folders, extensions ("punto t s") and line numbers are noise
 * — the editor is already showing the exact spot.
 */
function fileStem(uri: vscode.Uri): string {
  const base = uri.path.split('/').pop() ?? uri.path;
  return base.replace(/\.[A-Za-z0-9]+$/, '') || base;
}

/** What to say for a referent: its spoken form, else the file part of its label. */
function refSpeech(ref: Referent, es: boolean): string {
  if (ref.spoken) {
    return ref.spoken;
  }
  const match = ref.label.match(/([^/\\\s]+?)(?:\.[A-Za-z0-9]+)?:(\d+)$/);
  return match ? `${es ? 'en' : 'in'} ${match[1]}` : (ref.label.split('/').pop() ?? ref.label);
}

function listSpeech(refs: Referent[], header: string, es: boolean, openedFirst = false): string {
  // The best hit is already open: reading the list aloud is tedious. Say what
  // was opened, and how to move on; the list itself is in the panel (the
  // router also sees the REFERENTS table, so "open the one that isn't a test"
  // still works).
  if (openedFirst) {
    const rest = refs.length - 1;
    const restPart =
      rest > 0
        ? es
          ? ` Di "la siguiente" para ir a ${rest === 1 ? 'la otra' : 'la próxima'}.`
          : ` Say "next" to go to ${rest === 1 ? 'the other one' : 'the next one'}.`
        : '';
    return `${header}. ${es ? 'Te llevé a' : 'I took you to'} ${refSpeech(refs[0], es)}.${restPart}`;
  }
  // Nothing was opened: the user has to pick, so the top options are spoken.
  const top = refs
    .slice(0, 3)
    .map((r, i) => `${i + 1}, ${refSpeech(r, es)}`)
    .join('; ');
  const hint = es ? ' Di "ve al segundo" para saltar a otro.' : ' Say "go to the second one" to jump.';
  return `${header}: ${top}.${refs.length > 1 ? hint : ''}`;
}

/** "la función handle click" → "handleclick": what the user said, comparable to identifiers. */
function normalizeSymbolQuery(name: string): string {
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
function rankSymbols(
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

const CONTEXT_LINES = 30;

async function readAround(uri: vscode.Uri, range: vscode.Range): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const start = Math.max(0, range.start.line - 5);
  const end = Math.min(doc.lineCount - 1, Math.max(range.end.line, range.start.line + CONTEXT_LINES));
  return doc.getText(new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER));
}

function symbolToReferent(s: vscode.SymbolInformation, es: boolean): Omit<Referent, 'id'> {
  return {
    label: `${s.name} — ${locationLabel(s.location.uri, s.location.range)}`,
    uri: s.location.uri,
    range: s.location.range,
    spoken: `${s.name}, ${es ? 'en' : 'in'} ${fileStem(s.location.uri)}`,
  };
}
