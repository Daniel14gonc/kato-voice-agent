import * as vscode from 'vscode';
import { getConfig } from '../config';
import { EditReveal } from '../ui/editReveal';
import {
  resolveMode,
  say,
  type AgentCapabilities,
  type AgentMode,
  type AgentModeInfo,
  type AgentSession,
  type AgentSessionProvider,
  type AgentTodo,
  type PermissionRequest,
  type ToolActivity,
} from './agentSession';

const MAX_RECENT_TOOLS = 6;

/** Spoken progress is rare on purpose: at most one update this often… */
const PROGRESS_MIN_GAP_MS = 90_000;
/** …and never before the task has been running this long. */
const PROGRESS_MIN_RUNTIME_MS = 60_000;

/** What the panel and the status bar need to render the agent, pushed on every change. */
export interface AgentStatusUpdate {
  active: boolean;
  /** 'task' = a delegated coding session; 'explore' = a read-only repo exploration (tours). */
  kind: 'task' | 'explore';
  provider: string;
  state: string;
  mode: AgentMode;
  modeLabel: string;
  task: string;
  toolCount: number;
  /** Epoch ms the current task started — the panel renders a live elapsed timer. */
  startedAt?: number;
  /** Epoch ms the last turn finished, while the session sits ready. */
  finishedAt?: number;
  /** The step the agent is on, in its own words ("Escribiendo los tests"). */
  currentStep?: string;
  stepIndex?: number;
  stepCount?: number;
}

/**
 * The visual surface. Kato is voice-first, but a coding agent that works for
 * minutes needs a place to *show* what it is doing — the voice should only
 * carry what the user must hear.
 */
export interface AgentUi {
  status(update: AgentStatusUpdate): void;
  /** A tool call entering or leaving the running state. */
  tool(event: { id: string; label: string; detail?: string; state: 'running' | 'ok' | 'error'; hasOutput?: boolean }): void;
  /** The agent's own prose, streamed. */
  text(delta: string): void;
  /** A permission request became pending, or `undefined` when it cleared. */
  permission(request: { title: string; detail?: string; canRemember: boolean } | undefined): void;
  /** The agent's step list (full, ordered). */
  todos(todos: AgentTodo[]): void;
  /** A line in the conversation history: task started, step done, finished. */
  milestone(text: string): void;
  /** Brings the Kato panel into view without taking keyboard focus. */
  reveal(): void;
}

/** Normalized record of what the agent has been doing (feeds the snapshot). */
class AgentTracker {
  task = '';
  toolCount = 0;
  recentTools: string[] = [];
  lastResult = '';
  startedAt = 0;
  finishedAt: number | undefined;
  todos: AgentTodo[] = [];
  /** Whether the "it split the work into N steps" line was already said for this task. */
  announcedPlan = false;
  lastSpokenProgress = 0;

  reset(task: string): void {
    this.task = task;
    this.toolCount = 0;
    this.recentTools = [];
    this.lastResult = '';
    this.startedAt = Date.now();
    this.finishedAt = undefined;
    this.todos = [];
    this.announcedPlan = false;
    this.lastSpokenProgress = 0;
  }

  addTool(label: string): void {
    this.toolCount++;
    this.recentTools.push(label);
    if (this.recentTools.length > MAX_RECENT_TOOLS) {
      this.recentTools.shift();
    }
  }

  /** The step in progress, or the first one not done yet. */
  currentStep(): { todo: AgentTodo; index: number } | undefined {
    let index = this.todos.findIndex((todo) => todo.status === 'in_progress');
    if (index < 0) {
      index = this.todos.findIndex((todo) => todo.status === 'pending');
    }
    return index < 0 ? undefined : { todo: this.todos[index], index };
  }

  completedCount(): number {
    return this.todos.filter((todo) => todo.status === 'completed').length;
  }
}

/** A read-only exploration (deep understanding / tours) in flight. */
interface Exploration {
  question: string;
  provider: string;
  startedAt: number;
  toolCount: number;
}

/**
 * "sí, pero no me preguntes más por esto" — remember this one kind of action.
 * Only when the user scopes it; unscoped "no me preguntes más" means stop
 * asking, full stop.
 */
const SCOPED_REMEMBER_PATTERN =
  /(por|para|con) (esto|este|eso|ese)|este (comando|tipo)|(for|about) (this|that)( one| command)?\b|this (command|kind)/i;
const REMEMBER_PATTERN =
  /no me (vuelvas a )?pregunt|ya no (me )?pregunt|sin preguntar|siempre|deja de preguntar|don'?t ask( me)?( again| anymore)?|always allow|stop asking/i;

/**
 * "sí a todo" / "approve everything from here on" — not a per-tool exception
 * but a blanket waiver: the honest fulfillment is switching the agent to
 * auto. "sí a todo" used to approve just the one request, so the agent kept
 * asking right after the user said yes to everything.
 */
const BLANKET_PATTERN =
  /\beverything\b|\ball of (it|them)\b|\b(yes|approve( it)?|ok) (to )?all\b|\bto all\b|apru[eé]ba(lo)? todo|todo aprobado|\ba todo\b|con todo\b|todo lo que (pida|quiera|necesite)|de aqu[ií] en adelante|from (here|now) on/i;

/**
 * Owns the (single) live agent session for this window and turns its event
 * stream into supervision: a status line for the router snapshot, sparse
 * spoken milestones, a live panel feed, and voice-controlled
 * approve/deny/stop/steer.
 */
export class AgentManager {
  private session: AgentSession | undefined;
  private readonly tracker = new AgentTracker();
  /** Pending permission requests, oldest first — a bare "sí" answers the oldest. */
  private readonly pendingApprovals: PermissionRequest[] = [];
  private lastLanguageEs = true;
  /** Capabilities of the provider backing the live session. */
  private capabilities: AgentCapabilities | undefined;
  /** Provider that started the live session (may differ from settings). */
  private activeProvider: string | undefined;
  private exploration: Exploration | undefined;
  /** Approvals given by voice in this window — drives the one-time "sí a todo" tip. */
  private approvalsThisWindow = 0;
  private blanketTipGiven = false;
  private readonly edits = new EditReveal();

  constructor(
    private readonly providers: Record<string, AgentSessionProvider>,
    private readonly getSelected: () => { provider: string; model: string },
    private readonly log: (message: string) => void,
    /**
     * Speaks a spontaneous notification (queued if Kato is mid-conversation).
     * A `replaceKey` drops any queued notification with the same key, so a
     * stale progress update never plays after a fresher one.
     */
    private readonly notify: (text: string, options?: { replaceKey?: string }) => void,
    /** Dedicated channel where agent command output (Bash etc.) is streamed. */
    private readonly agentOutput: vscode.OutputChannel,
    private readonly ui: AgentUi,
  ) {}

  get active(): boolean {
    return this.session !== undefined && this.session.state !== 'closed';
  }

  get waitingApproval(): boolean {
    return this.pendingApprovals.length > 0;
  }

  /** The provider that owns the live session, else the one settings point at. */
  private provider(): AgentSessionProvider | undefined {
    return this.providers[this.activeProvider ?? this.getSelected().provider];
  }

  private providerLabel(): string {
    return this.provider()?.label ?? this.activeProvider ?? this.getSelected().provider;
  }

  private modes(): AgentModeInfo[] {
    return this.provider()?.modes ?? [];
  }

  private modeInfo(id: AgentMode | undefined): AgentModeInfo | undefined {
    return this.modes().find((mode) => mode.id === id);
  }

  /** The level chosen by voice or in settings; survives restarts. */
  private preferredMode(): AgentMode | undefined {
    return getConfig().agentDefaultMode || undefined;
  }

  private currentMode(): AgentMode {
    return (
      this.session?.mode ??
      this.preferredMode() ??
      this.modes().find((mode) => mode.isDefault)?.id ??
      'agent'
    );
  }

  private modeLabel(es: boolean): string {
    const info = this.modeInfo(this.currentMode());
    return info ? (es ? info.label : info.labelEn) : String(this.currentMode());
  }

  private pushStatus(): void {
    if (this.exploration) {
      this.ui.status({
        active: true,
        kind: 'explore',
        provider: this.exploration.provider,
        state: 'exploring',
        mode: 'plan',
        modeLabel: this.lastLanguageEs ? 'solo lectura' : 'read-only',
        task: this.exploration.question,
        toolCount: this.exploration.toolCount,
        startedAt: this.exploration.startedAt,
      });
      return;
    }
    const step = this.tracker.currentStep();
    const state = this.session?.state ?? 'idle';
    this.ui.status({
      active: this.active,
      kind: 'task',
      provider: this.providerLabel(),
      state,
      mode: this.currentMode(),
      modeLabel: this.modeLabel(this.lastLanguageEs),
      task: this.tracker.task,
      toolCount: this.tracker.toolCount,
      startedAt: this.tracker.startedAt || undefined,
      finishedAt: state === 'ready' ? this.tracker.finishedAt : undefined,
      currentStep: step ? (step.todo.activeText ?? step.todo.text) : undefined,
      stepIndex: step ? step.index + 1 : undefined,
      stepCount: this.tracker.todos.length || undefined,
    });
  }

  /** Snapshot line for the router; empty when no session is live. */
  statusLine(): string {
    if (this.exploration) {
      return `AGENT: ${this.exploration.provider} is exploring the repo read-only for "${this.exploration.question.slice(0, 120)}" (a tour/explanation is on its way).`;
    }
    if (!this.active || !this.session) {
      return '';
    }
    const pending = this.pendingApprovals[0];
    const state = pending
      ? `WAITING FOR VOICE APPROVAL: "${say(pending.title, true)}" — an affirmative ("sí", "dale", ` +
        `"apruébalo", "yes", "sí a todo") → agent_control approve, a negative → agent_control deny. NEVER confirm_action.`
      : this.session.state === 'ready'
        ? 'ready — it finished its turn. An affirmative or a restated task is a NEW instruction: agent_control is wrong, use agent_delegate to steer it.'
        : this.session.state;
    const step = this.tracker.currentStep();
    const steps = this.tracker.todos.length
      ? ` Plan: step ${step ? step.index + 1 : this.tracker.todos.length} of ${this.tracker.todos.length}${step ? ` ("${step.todo.text}")` : ''}.`
      : '';
    const recent = this.tracker.recentTools.length
      ? ` Recent tools: ${this.tracker.recentTools.join('; ')}.`
      : '';
    const modes = this.modes()
      .map((mode) => mode.id)
      .join(', ');
    return (
      `AGENT: ${this.providerLabel()} session ${state} (mode ${this.currentMode()}), ` +
      `task: "${this.tracker.task.slice(0, 120)}", ${this.tracker.toolCount} tools used.${steps}${recent} ` +
      `Permission levels this agent supports: ${modes} — "what modes do you have" → agent_control list_modes, ` +
      `"put it on X" → agent_control set_mode.`
    );
  }

  /**
   * Starts a task, or steers the running session if one is live. Returns the
   * spoken acknowledgment.
   */
  delegate(instruction: string, mode: AgentMode | undefined, contextText: string, es: boolean): string {
    this.lastLanguageEs = es;
    this.ui.reveal();
    // Switching kato.agent.provider mid-session: retire the old one so the new
    // task actually runs on the agent the user picked.
    if (this.active && this.activeProvider !== this.getSelected().provider) {
      this.log(`[agent] provider changed to ${this.getSelected().provider}; closing the previous session`);
      this.session?.dispose();
      this.session = undefined;
      this.pendingApprovals.length = 0;
    }
    if (this.active && this.session) {
      const wasReady = this.session.state === 'ready';
      this.session.send(instruction);
      if (wasReady) {
        // A new turn on the same session: a fresh task for the panel and timer.
        this.tracker.reset(instruction);
        this.ui.todos([]);
      }
      this.ui.milestone(`→ ${instruction}`);
      this.log(`[agent] steering: ${instruction}`);
      this.pushStatus();
      if (this.capabilities?.liveSteering === false && !wasReady) {
        // Codex-style agents finish the current turn before taking new input.
        return es
          ? `${this.providerLabel()} no acepta instrucciones a mitad de turno, así que se la paso en cuanto termine lo que está haciendo.`
          : `${this.providerLabel()} can't take input mid-turn, so I'll pass it on as soon as it finishes.`;
      }
      return es ? `Se lo paso a ${this.providerLabel()}.` : `Passing that on to ${this.providerLabel()}.`;
    }

    const { provider: providerName, model } = this.getSelected();
    const provider = this.providers[providerName];
    if (!provider) {
      return es ? `No conozco el proveedor de agente ${providerName}.` : `Unknown agent provider ${providerName}.`;
    }
    this.capabilities = provider.capabilities;
    this.activeProvider = providerName;
    let effectiveMode: AgentMode =
      mode ?? this.preferredMode() ?? provider.modes.find((m) => m.isDefault)?.id ?? 'agent';
    let degraded = '';
    // The catalog, not a capability flag, is the source of truth for what this
    // agent can do — that is what makes the layer agent-agnostic.
    if (!provider.modes.some((m) => m.id === effectiveMode)) {
      const fallback = provider.modes.find((m) => m.isDefault) ?? provider.modes[0];
      const wanted = effectiveMode;
      effectiveMode = fallback?.id ?? 'agent';
      degraded = es
        ? `${provider.label} no tiene modo ${wanted}, así que lo dejo en ${fallback ? fallback.label : effectiveMode}. `
        : `${provider.label} has no ${wanted} mode, so I'm using ${fallback ? fallback.labelEn : effectiveMode}. `;
    }
    const roots = contextRoots();
    if (!roots) {
      return es ? 'No hay ningún proyecto abierto donde trabajar.' : 'There is no open project to work in.';
    }
    this.tracker.reset(instruction);
    this.pendingApprovals.length = 0;
    this.edits.reset();
    this.ui.todos([]);
    this.session = provider.startSession({
      cwd: roots.cwd,
      extraDirs: roots.extraDirs,
      model: model || undefined,
      mode: effectiveMode,
      es,
      events: {
        onTool: (activity) => this.onTool(activity),
        onToolDone: (activity, result) => this.onToolDone(activity, result),
        onAgentText: (delta) => this.ui.text(delta),
        onFileEdited: (filePath) => this.edits.didEdit(filePath),
        onTodos: (todos) => this.onTodos(todos),
        onTurnComplete: (resultText, isError) => this.onTurnComplete(resultText, isError),
        onPermissionRequest: (request) => this.onPermissionRequest(request),
        onPermissionResolved: (id) => this.onPermissionResolved(id),
        onQuestion: (question, options) => this.onQuestion(question, options),
        onError: (message) => {
          this.log(`[agent error] ${message}`);
          this.pushStatus();
          this.ui.milestone(`✗ ${message.slice(0, 200)}`);
          this.notify(
            this.lastLanguageEs ? `El agente falló: ${message.slice(0, 140)}` : `The agent failed: ${message.slice(0, 140)}`,
          );
        },
      },
    });
    this.session.send(buildTaskPrompt(instruction, contextText, effectiveMode));
    this.log(`[agent] delegated (${effectiveMode}): ${instruction}`);
    this.ui.milestone(`▶ ${provider.label}: ${instruction}`);
    this.pushStatus();
    if (effectiveMode === 'plan') {
      return (
        degraded +
        (es
          ? `Va. Le pido un plan a ${provider.label} y te lo leo en cuanto esté.`
          : `On it. I'll ask ${provider.label} for a plan and read it to you when it's ready.`)
      );
    }
    return (
      degraded +
      (es
        ? `Va, se lo paso a ${provider.label}. Te aviso si me necesita o cuando termine.`
        : `On it — handing it to ${provider.label}. I'll tell you if it needs you or when it's done.`)
    );
  }

  // ---------- read-only exploration (tours) ----------
  //
  // Tours run the agent headless and used to be invisible: the panel said
  // nothing for up to four minutes, so it looked like Kato was trying to
  // answer by itself instead of delegating. They now use the same card.

  beginExploration(question: string, providerName: string, es: boolean): void {
    this.lastLanguageEs = es;
    const label = this.providers[providerName]?.label ?? providerName;
    this.exploration = { question, provider: label, startedAt: Date.now(), toolCount: 0 };
    this.ui.reveal();
    this.ui.todos([]);
    this.ui.milestone(`▶ ${label} (${es ? 'explorando' : 'exploring'}): ${question}`);
    this.pushStatus();
  }

  explorationActivity(activity: ToolActivity): void {
    if (!this.exploration) {
      return;
    }
    this.exploration.toolCount++;
    const label = say(activity.label, this.lastLanguageEs);
    this.ui.tool({ id: `explore:${activity.id}`, label, detail: activity.detail, state: 'ok' });
    this.pushStatus();
  }

  endExploration(ok: boolean): void {
    if (!this.exploration) {
      return;
    }
    const seconds = Math.round((Date.now() - this.exploration.startedAt) / 1000);
    this.ui.milestone(
      ok
        ? this.lastLanguageEs
          ? `✓ Exploración lista en ${formatDuration(seconds, true)}`
          : `✓ Exploration done in ${formatDuration(seconds, false)}`
        : this.lastLanguageEs
          ? '✗ La exploración no terminó'
          : '✗ The exploration did not finish',
    );
    this.exploration = undefined;
    // The card goes back to the live task, if any: restore its checklist.
    this.ui.todos(this.tracker.todos);
    this.pushStatus();
  }

  // ---------- session events ----------

  private onTool(activity: ToolActivity): void {
    const label = say(activity.label, this.lastLanguageEs);
    this.tracker.addTool(label);
    this.log(`[agent] ${activity.name}: ${label}`);
    this.ui.tool({ id: activity.id, label, detail: activity.detail, state: 'running' });
    this.pushStatus();
    if (activity.filePath) {
      // Snapshot now, before the edit executes, so the reveal can diff it.
      this.edits.willEdit(activity.filePath);
    }
  }

  private onToolDone(activity: ToolActivity, result: { ok: boolean; output?: string }): void {
    this.ui.tool({
      id: activity.id,
      label: say(activity.label, this.lastLanguageEs),
      detail: activity.detail,
      state: result.ok ? 'ok' : 'error',
      hasOutput: result.output !== undefined,
    });
    if (result.output === undefined) {
      return;
    }
    // Not shown automatically any more: the Output view lives in the same
    // panel as Kato and opening it hid the Kato panel right when the user
    // wanted to watch the agent. The panel row links here instead.
    this.agentOutput.appendLine(`$ ${activity.detail ?? activity.name}`);
    this.agentOutput.appendLine(result.output.trim() ? result.output.trim() : '(no output)');
    this.agentOutput.appendLine('');
  }

  private onTodos(todos: AgentTodo[]): void {
    const previous = this.tracker.todos;
    this.tracker.todos = todos;
    this.ui.todos(todos);
    this.pushStatus();
    const es = this.lastLanguageEs;
    // Newly completed steps are history-worthy; they are also the only
    // moments progress may be spoken.
    const newlyDone = todos.filter(
      (todo) =>
        todo.status === 'completed' &&
        previous.some((old) => old.id === todo.id && old.text === todo.text && old.status !== 'completed'),
    );
    for (const todo of newlyDone) {
      this.ui.milestone(`✓ ${todo.text}`);
    }
    if (getConfig().agentSpokenUpdates === 'minimal' || this.session?.mode === 'plan') {
      return;
    }
    if (!this.tracker.announcedPlan && todos.length >= 3) {
      this.tracker.announcedPlan = true;
      this.tracker.lastSpokenProgress = Date.now();
      this.notify(
        es
          ? `${this.providerLabel()} lo dividió en ${todos.length} pasos.`
          : `${this.providerLabel()} split it into ${todos.length} steps.`,
        { replaceKey: 'agent-progress' },
      );
      return;
    }
    const now = Date.now();
    const done = this.tracker.completedCount();
    if (
      newlyDone.length === 0 ||
      done >= todos.length || // the completion message covers the last step
      now - this.tracker.startedAt < PROGRESS_MIN_RUNTIME_MS ||
      now - this.tracker.lastSpokenProgress < PROGRESS_MIN_GAP_MS
    ) {
      return;
    }
    this.tracker.lastSpokenProgress = now;
    const next = this.tracker.currentStep();
    const nextText = next ? `: ${lowerFirst(next.todo.activeText ?? next.todo.text)}` : '';
    this.notify(
      es
        ? `Va en el paso ${done + 1} de ${todos.length}${nextText}.`
        : `On step ${done + 1} of ${todos.length}${nextText}.`,
      { replaceKey: 'agent-progress' },
    );
  }

  private onPermissionRequest(request: PermissionRequest): void {
    this.pendingApprovals.push(request);
    const es = this.lastLanguageEs;
    const what = say(request.title, es);
    this.log(`[agent] permission request: ${what}`);
    this.ui.permission({ title: what, detail: request.detail, canRemember: request.canRemember });
    this.ui.reveal();
    this.pushStatus();
    // Only the oldest request is announced: the rest are answered in turn, and
    // reading three prompts over each other is unusable by voice.
    if (this.pendingApprovals.length > 1) {
      return;
    }
    this.notify(
      es
        ? `${this.providerLabel()} quiere ${what}. ¿Le doy permiso?`
        : `${this.providerLabel()} wants to ${what}. Should I allow it?`,
    );
  }

  private onPermissionResolved(id: string): void {
    const index = this.pendingApprovals.findIndex((request) => request.id === id);
    if (index >= 0) {
      this.pendingApprovals.splice(index, 1);
    }
    const next = this.pendingApprovals[0];
    this.ui.permission(
      next ? { title: say(next.title, this.lastLanguageEs), detail: next.detail, canRemember: next.canRemember } : undefined,
    );
    this.pushStatus();
    // In auto the queue is being drained by the auto-approval itself; reading
    // each drained request aloud would be pure noise.
    if (next && this.session?.mode !== 'auto') {
      const es = this.lastLanguageEs;
      const what = say(next.title, es);
      this.notify(es ? `Ahora quiere ${what}. ¿Le doy permiso?` : `Now it wants to ${what}. Should I allow it?`);
    }
  }

  /**
   * The agent tried to ask via a UI tool Kato cannot render. The provider
   * already declined it; here we make sure the question still reaches the user
   * out loud, so it is answered as a normal spoken instruction.
   */
  private onQuestion(question: string, options: string[]): void {
    const es = this.lastLanguageEs;
    const choices = options.length ? ` ${es ? 'Opciones' : 'Options'}: ${options.join(', ')}.` : '';
    this.log(`[agent] question: ${question}`);
    this.notify(`${spoken(question)}${choices}`);
  }

  private onTurnComplete(resultText: string, isError: boolean): void {
    this.tracker.lastResult = resultText;
    this.tracker.finishedAt = Date.now();
    this.edits.reset();
    this.pushStatus();
    const es = this.lastLanguageEs;
    const seconds = Math.round((this.tracker.finishedAt - this.tracker.startedAt) / 1000);
    if (isError) {
      this.ui.milestone(`✗ ${spoken(resultText).slice(0, 200)}`);
      this.notify(es ? `El agente terminó con un error: ${spoken(resultText).slice(0, 200)}` : `The agent hit an error: ${spoken(resultText).slice(0, 200)}`);
      return;
    }
    this.ui.milestone(es ? `✓ Terminó en ${formatDuration(seconds, true)}` : `✓ Finished in ${formatDuration(seconds, false)}`);
    // Prefer the agent's dedicated spoken summary; fall back to the full text.
    const spokenMatch = resultText.match(/SPOKEN:\s*([\s\S]+)$/);
    const summary = spoken(spokenMatch ? spokenMatch[1] : resultText).slice(0, 600);
    if (this.session?.mode === 'plan') {
      this.notify(
        es
          ? `El plan está listo: ${summary} … Di "adelante" para ejecutarlo, o dime qué cambiar.`
          : `The plan is ready: ${summary} … Say "go ahead" to run it, or tell me what to change.`,
        { replaceKey: 'agent-progress' },
      );
    } else {
      this.notify(es ? `Listo. ${summary}` : `Done. ${summary}`, { replaceKey: 'agent-progress' });
    }
  }

  // ---------- voice control ----------

  /** Spoken status — answers "¿qué está haciendo?" in plain words, never a command line. */
  status(es: boolean): string {
    if (this.exploration) {
      const elapsed = formatDuration(Math.round((Date.now() - this.exploration.startedAt) / 1000), es);
      return es
        ? `${this.exploration.provider} sigue explorando el código, lleva ${elapsed}. Te aviso cuando tenga el tour.`
        : `${this.exploration.provider} is still exploring the code, ${elapsed} so far. I'll tell you when the tour is ready.`;
    }
    if (!this.active || !this.session) {
      return es ? 'No hay ninguna tarea delegada ahora mismo.' : 'No task is delegated right now.';
    }
    const name = this.providerLabel();
    const pending = this.pendingApprovals[0];
    if (pending) {
      return es
        ? `${name} está esperando tu permiso para ${say(pending.title, true)}.`
        : `${name} is waiting for your OK to ${say(pending.title, false)}.`;
    }
    if (this.session.state === 'ready') {
      return es ? `${name} terminó y espera instrucciones.` : `${name} finished and is awaiting instructions.`;
    }
    const elapsed = formatDuration(Math.round((Date.now() - this.tracker.startedAt) / 1000), es);
    const step = this.tracker.currentStep();
    if (step) {
      const what = lowerFirst(step.todo.activeText ?? step.todo.text);
      return es
        ? `${name} va en el paso ${step.index + 1} de ${this.tracker.todos.length}: ${what}. Lleva ${elapsed}.`
        : `${name} is on step ${step.index + 1} of ${this.tracker.todos.length}: ${what}. ${elapsed} so far.`;
    }
    return es
      ? `${name} sigue trabajando, lleva ${elapsed}. Lo último fue ${this.tracker.recentTools.at(-1) ?? 'leer el código'}.`
      : `${name} is still working, ${elapsed} so far. Last it did: ${this.tracker.recentTools.at(-1) ?? 'read the code'}.`;
  }

  /**
   * A spoken yes. When nothing is pending this used to dead-end on "no hay nada
   * que aprobar" — in a real session that swallowed the user's instruction
   * twice — so an affirmative with no pending request steers the agent instead.
   */
  approve(es: boolean, transcript?: string): string {
    this.lastLanguageEs = es;
    if (!this.waitingApproval) {
      return this.steerInstead(es, transcript);
    }
    this.approvalsThisWindow++;
    const scoped = transcript !== undefined && SCOPED_REMEMBER_PATTERN.test(transcript);
    const stopAsking = transcript !== undefined && REMEMBER_PATTERN.test(transcript);
    if (transcript !== undefined && (BLANKET_PATTERN.test(transcript) || (stopAsking && !scoped))) {
      this.session?.approve({});
      // Announces failures itself via the log; the spoken reply below already
      // tells the user what happened and how to revert.
      void this.setPermissionLevel(es ? 'automático' : 'auto', es);
      return es
        ? 'Hecho, lo pongo en automático y dejo de preguntarte. Si quieres volver a aprobar cada paso, di "modo normal".'
        : 'Done — switching to auto, so I stop asking. Say "normal mode" to approve steps again.';
    }
    const canRemember = this.pendingApprovals[0]?.canRemember === true;
    const remember = stopAsking && scoped;
    this.session?.approve({ remember: remember && canRemember });
    if (remember && !canRemember) {
      return es
        ? 'Aprobado. Esa excepción no la puedo recordar; si quieres, di "sí a todo" y dejo de preguntarte.'
        : 'Approved. I can\'t remember that exception; say "yes to all" and I\'ll stop asking.';
    }
    if (remember) {
      return es ? 'Aprobado, y no te vuelvo a preguntar por esto.' : "Approved, and I won't ask about this again.";
    }
    // Teach the escape hatch once, at the moment it becomes useful.
    if (this.approvalsThisWindow >= 2 && !this.blanketTipGiven && this.currentMode() !== 'auto') {
      this.blanketTipGiven = true;
      return es
        ? 'Aprobado. Si no quieres que te siga preguntando, la próxima di "sí a todo".'
        : 'Approved. If you don\'t want me to keep asking, next time say "yes to all".';
    }
    return es ? 'Aprobado.' : 'Approved.';
  }

  deny(es: boolean, transcript?: string): string {
    this.lastLanguageEs = es;
    if (!this.waitingApproval) {
      return this.steerInstead(es, transcript);
    }
    this.session?.deny();
    return es ? 'No se lo dejé hacer. Va a buscar otra forma.' : "Blocked it. It'll find another way.";
  }

  /**
   * Nothing was pending: the user is talking to the agent, not answering it.
   * Pass their words through rather than dead-ending the turn.
   */
  private steerInstead(es: boolean, transcript?: string): string {
    if (!this.active || !this.session || !transcript?.trim()) {
      return es ? 'No hay nada pendiente de aprobar.' : 'There is nothing pending approval.';
    }
    this.session.send(transcript);
    this.log(`[agent] nothing pending; forwarded as steering: ${transcript}`);
    this.pushStatus();
    return es ? `Se lo paso a ${this.providerLabel()}.` : `Passing that on to ${this.providerLabel()}.`;
  }

  /** Reads the live provider's permission catalog out loud. */
  listModes(es: boolean): string {
    const modes = this.modes();
    if (modes.length === 0) {
      return es ? 'Este agente no expone niveles de permisos.' : "This agent doesn't expose permission levels.";
    }
    const current = this.modeInfo(this.currentMode());
    const list = modes
      .map((mode) => `${es ? mode.label : mode.labelEn}, ${es ? mode.summary : mode.summaryEn}`)
      .join('. ');
    const now = current
      ? es
        ? ` Ahora mismo está en ${current.label}.`
        : ` Right now it's on ${current.labelEn}.`
      : '';
    return es
      ? `${this.providerLabel()} tiene ${modes.length} niveles. ${list}.${now}`
      : `${this.providerLabel()} has ${modes.length} levels. ${list}.${now}`;
  }

  /**
   * Voice-controlled permission level, resolved against the live provider's own
   * catalog. Unknown levels read the real options back instead of guessing.
   * The choice is written to `kato.agent.defaultMode`, so it holds for future
   * tasks and survives restarts — it used to reset with every window.
   */
  async setPermissionLevel(spokenMode: string, es: boolean): Promise<string> {
    this.lastLanguageEs = es;
    const modes = this.modes();
    const target = resolveMode(modes, spokenMode);
    if (!target) {
      const names = modes.map((mode) => (es ? mode.label : mode.labelEn)).join(', ');
      return es
        ? `${this.providerLabel()} no tiene ese nivel. Los que sí tiene son: ${names}.`
        : `${this.providerLabel()} has no such level. The ones it does have are: ${names}.`;
    }
    try {
      await vscode.workspace
        .getConfiguration('kato')
        .update('agent.defaultMode', target.id, vscode.ConfigurationTarget.Global);
    } catch (err) {
      this.log(`[agent] could not persist defaultMode: ${String(err)}`);
    }
    if (this.active && this.session) {
      try {
        await this.session.setMode(target.id);
      } catch (err) {
        // A provider refusing the switch must not kill the turn.
        this.log(`[agent] setMode(${target.id}) failed: ${String(err)}`);
        return es
          ? `${this.providerLabel()} no me dejó cambiar el nivel de permisos: ${String(err).slice(0, 120)}`
          : `${this.providerLabel()} refused the permission change: ${String(err).slice(0, 120)}`;
      }
      // Switching to a level that never asks must also clear what is parked,
      // otherwise the agent sits on approvals the user just waived.
      if (target.id === 'auto') {
        this.pendingApprovals.length = 0;
        this.ui.permission(undefined);
      }
    }
    this.pushStatus();
    return es
      ? `Listo, modo ${target.label}: ${target.summary}.`
      : `Done, ${target.labelEn} mode: ${target.summaryEn}.`;
  }

  /** Plan approved by voice: switch to a writing level and tell the agent to go. */
  async continuePlan(es: boolean): Promise<string> {
    this.lastLanguageEs = es;
    if (!this.active || !this.session) {
      return es ? 'No hay ningún plan esperando.' : 'There is no plan waiting.';
    }
    // "Adelante" while a tool is parked means "approve it", not "run the plan".
    if (this.waitingApproval) {
      return this.approve(es);
    }
    if (this.session.mode === 'plan') {
      // Leaving plan mode is the point; anything else the user chose is theirs
      // to keep, so only plan mode is overridden here.
      const preferred = this.preferredMode();
      const writing =
        this.modes().find((mode) => mode.id === preferred && mode.id !== 'plan') ??
        this.modes().find((mode) => mode.isDefault) ??
        this.modes().find((mode) => mode.id !== 'plan');
      if (writing) {
        await this.session.setMode(writing.id);
      }
    }
    this.tracker.reset(this.tracker.task);
    this.session.send('The user approved the plan by voice. Proceed with the implementation now.');
    this.ui.milestone(es ? '▶ Plan aprobado' : '▶ Plan approved');
    this.pushStatus();
    return es ? 'Adelante, ejecuta el plan.' : 'Go — executing the plan.';
  }

  async stop(es: boolean): Promise<string> {
    if (!this.active || !this.session) {
      return es ? 'No hay ninguna tarea que detener.' : 'There is no task to stop.';
    }
    await this.session.interrupt();
    this.pendingApprovals.length = 0;
    this.ui.permission(undefined);
    this.ui.milestone(es ? '■ Detenido' : '■ Stopped');
    this.pushStatus();
    return es ? 'Detenido. Si quieres, dime cómo seguir.' : 'Stopped. Tell me how to continue if you want.';
  }

  dispose(): void {
    this.session?.dispose();
    this.session = undefined;
    this.edits.dispose();
  }
}

function buildTaskPrompt(instruction: string, contextText: string, mode: AgentMode): string {
  return (
    `${instruction}\n\n` +
    `Context — what the user currently sees in VS Code:\n${contextText}\n\n` +
    (mode === 'plan'
      ? 'Present a concise plan. Keep the summary tight — it will be read aloud.\n'
      : '') +
    'You are driven by voice: there is no interactive UI, so never use question or dialog tools. ' +
    'If you need a decision from the user, ask for it in plain text and stop — their spoken reply arrives as the next message.\n' +
    'For tasks with 3+ steps, keep a todo list updated: it is shown to the user as your progress.\n' +
    'When you finish, end your reply with a final line starting with exactly "SPOKEN: " followed by a 1-3 sentence ' +
    'spoken-style summary of what you did (no markdown, no lists, no file paths — say file names naturally). ' +
    'Only that line is read aloud to the user by TTS.'
  );
}

/** Markdown → speakable text (rough but effective). */
function spoken(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' … ')
    .replace(/[*_#`>|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lowerFirst(text: string): string {
  return /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** 75 → "1 minuto 15 segundos" / "1 minute 15 seconds". */
export function formatDuration(totalSeconds: number, es: boolean): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const unit = (n: number, esWord: string, enWord: string) =>
    `${n} ${es ? esWord : enWord}${n === 1 ? '' : es && esWord.endsWith('n') ? 'es' : 's'}`;
  if (minutes === 0) {
    return unit(seconds, 'segundo', 'second');
  }
  if (seconds === 0 || minutes >= 5) {
    return unit(minutes, 'minuto', 'minute');
  }
  return `${unit(minutes, 'minuto', 'minute')} ${unit(seconds, 'segundo', 'second')}`;
}

function contextRoots(): { cwd: string; extraDirs: string[] } | undefined {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (folders.length === 0) {
    return undefined;
  }
  return { cwd: folders[0], extraDirs: folders.slice(1) };
}
