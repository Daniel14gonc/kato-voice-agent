import * as vscode from 'vscode';
import { TypewriterReveal } from '../ui/typewriterReveal';
import {
  resolveMode,
  say,
  type AgentCapabilities,
  type AgentMode,
  type AgentModeInfo,
  type AgentSession,
  type AgentSessionProvider,
  type PermissionRequest,
  type ToolActivity,
} from './agentSession';

const MAX_RECENT_TOOLS = 6;

/** What the panel needs to render the agent, pushed on every change. */
export interface AgentStatusUpdate {
  active: boolean;
  provider: string;
  state: string;
  mode: AgentMode;
  modeLabel: string;
  task: string;
  toolCount: number;
}

/**
 * The panel surface. Kato is voice-first, but a coding agent that works for
 * minutes needs a place to *show* what it is doing — the log channel was not
 * it, and the user had no way to tell whether anything was happening.
 */
export interface AgentUi {
  status(update: AgentStatusUpdate): void;
  /** A tool call entering or leaving the running state. */
  tool(event: { id: string; label: string; detail?: string; state: 'running' | 'ok' | 'error' }): void;
  /** The agent's own prose, streamed. */
  text(delta: string): void;
  /** A permission request became pending, or `undefined` when it cleared. */
  permission(request: { title: string; detail?: string; canRemember: boolean } | undefined): void;
}

/** Normalized record of what the agent has been doing (feeds the snapshot). */
class AgentTracker {
  task = '';
  toolCount = 0;
  recentTools: string[] = [];
  lastResult = '';

  reset(task: string): void {
    this.task = task;
    this.toolCount = 0;
    this.recentTools = [];
    this.lastResult = '';
  }

  addTool(label: string): void {
    this.toolCount++;
    this.recentTools.push(label);
    if (this.recentTools.length > MAX_RECENT_TOOLS) {
      this.recentTools.shift();
    }
  }
}

/** "sí, y no me preguntes más" — approve *and* stop asking for this tool. */
const REMEMBER_PATTERN =
  /no me (vuelvas a )?pregunt|ya no pregunt|sin preguntar|siempre|don'?t ask( me)? again|always allow|stop asking/i;

/**
 * "approve everything from here on" / "apruébalo todo" — not a per-tool
 * exception but a blanket waiver: the honest fulfillment is switching the
 * agent to auto, otherwise it keeps asking and the user keeps repeating it.
 */
const BLANKET_PATTERN =
  /\beverything\b|approve (it )?all\b|all of (it|them)\b|apru[eé]ba(lo)? todo|todo aprobado|de aqu[ií] en adelante|from (here|now) on/i;

/**
 * Owns the (single) live agent session for this window and turns its event
 * stream into supervision: a status line for the router snapshot, spoken
 * milestone notifications, a live panel feed, and voice-controlled
 * approve/deny/stop/steer.
 */
export class AgentManager {
  private session: AgentSession | undefined;
  private readonly tracker = new AgentTracker();
  /** Pending permission requests, oldest first — a bare "sí" answers the oldest. */
  private readonly pendingApprovals: PermissionRequest[] = [];
  private lastLanguageEs = true;
  private outputShown = false;
  /** Voice-set permission preference; applies to the live session and future ones. */
  private preferredMode: AgentMode | undefined;
  /** Capabilities of the provider backing the live session. */
  private capabilities: AgentCapabilities | undefined;
  /** Provider that started the live session (may differ from settings). */
  private activeProvider: string | undefined;
  /** Animates freshly-inserted code appearing character by character. */
  private readonly typewriter = new TypewriterReveal();
  /** Freshly-inserted code gets a brief green wash so edits are followable. */
  private readonly editDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(129, 199, 132, 0.25)',
    isWholeLine: true,
    overviewRulerColor: '#81c784',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor(
    private readonly providers: Record<string, AgentSessionProvider>,
    private readonly getSelected: () => { provider: string; model: string },
    private readonly log: (message: string) => void,
    /** Speaks a spontaneous notification (queued if Kato is mid-conversation). */
    private readonly notify: (text: string) => void,
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

  private currentMode(): AgentMode {
    return (
      this.session?.mode ??
      this.preferredMode ??
      this.modes().find((mode) => mode.isDefault)?.id ??
      'agent'
    );
  }

  private modeLabel(es: boolean): string {
    const info = this.modeInfo(this.currentMode());
    return info ? (es ? info.label : info.labelEn) : String(this.currentMode());
  }

  private pushStatus(): void {
    this.ui.status({
      active: this.active,
      provider: this.providerLabel(),
      state: this.session?.state ?? 'idle',
      mode: this.currentMode(),
      modeLabel: this.modeLabel(this.lastLanguageEs),
      task: this.tracker.task,
      toolCount: this.tracker.toolCount,
    });
  }

  /** Snapshot line for the router; empty when no session is live. */
  statusLine(): string {
    if (!this.active || !this.session) {
      return '';
    }
    const pending = this.pendingApprovals[0];
    const state = pending
      ? `WAITING FOR VOICE APPROVAL: "${say(pending.title, true)}" — an affirmative ("sí", "dale", ` +
        `"apruébalo", "yes") → agent_control approve, a negative → agent_control deny. NEVER confirm_action.`
      : this.session.state === 'ready'
        ? 'ready — it finished its turn. An affirmative or a restated task is a NEW instruction: agent_control is wrong, use agent_delegate to steer it.'
        : this.session.state;
    const recent = this.tracker.recentTools.length
      ? ` Recent tools: ${this.tracker.recentTools.join('; ')}.`
      : '';
    const modes = this.modes()
      .map((mode) => mode.id)
      .join(', ');
    return (
      `AGENT: ${this.providerLabel()} session ${state} (mode ${this.currentMode()}), ` +
      `task: "${this.tracker.task.slice(0, 120)}", ${this.tracker.toolCount} tools used.${recent} ` +
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
    // Switching kato.agent.provider mid-session: retire the old one so the new
    // task actually runs on the agent the user picked.
    if (this.active && this.activeProvider !== this.getSelected().provider) {
      this.log(`[agent] provider changed to ${this.getSelected().provider}; closing the previous session`);
      this.session?.dispose();
      this.session = undefined;
      this.pendingApprovals.length = 0;
    }
    if (this.active && this.session) {
      this.session.send(instruction);
      this.tracker.task = `${this.tracker.task} +steering`;
      this.log(`[agent] steering: ${instruction}`);
      this.pushStatus();
      if (this.capabilities?.liveSteering === false && this.session.state === 'working') {
        // Codex-style agents finish the current turn before taking new input.
        return es
          ? `${this.providerLabel()} no acepta instrucciones a mitad de turno, así que se la paso en cuanto termine lo que está haciendo.`
          : `${this.providerLabel()} can't take input mid-turn, so I'll pass it on as soon as it finishes.`;
      }
      return es ? 'Le paso la instrucción al agente.' : 'Passing that on to the agent.';
    }

    const { provider: providerName, model } = this.getSelected();
    const provider = this.providers[providerName];
    if (!provider) {
      return es ? `No conozco el proveedor de agente ${providerName}.` : `Unknown agent provider ${providerName}.`;
    }
    this.capabilities = provider.capabilities;
    this.activeProvider = providerName;
    let effectiveMode: AgentMode =
      mode ?? this.preferredMode ?? provider.modes.find((m) => m.isDefault)?.id ?? 'agent';
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
    this.outputShown = false;
    this.pendingApprovals.length = 0;
    this.session = provider.startSession({
      cwd: roots.cwd,
      extraDirs: roots.extraDirs,
      model: model || undefined,
      mode: effectiveMode,
      events: {
        onTool: (activity) => this.onTool(activity),
        onToolDone: (activity, result) => this.onToolDone(activity, result),
        onAgentText: (delta) => this.ui.text(delta),
        onFileEdited: (filePath, addedText) => void this.highlightEdit(filePath, addedText),
        onTurnComplete: (resultText, isError) => this.onTurnComplete(resultText, isError),
        onPermissionRequest: (request) => this.onPermissionRequest(request),
        onPermissionResolved: (id) => this.onPermissionResolved(id),
        onQuestion: (question, options) => this.onQuestion(question, options),
        onError: (message) => {
          this.log(`[agent error] ${message}`);
          this.pushStatus();
          this.notify(
            this.lastLanguageEs ? `El agente falló: ${message.slice(0, 140)}` : `The agent failed: ${message.slice(0, 140)}`,
          );
        },
      },
    });
    this.session.send(buildTaskPrompt(instruction, contextText, effectiveMode));
    this.log(`[agent] delegated (${effectiveMode}): ${instruction}`);
    this.pushStatus();
    if (effectiveMode === 'plan') {
      return (
        degraded +
        (es
          ? 'Va. Le pido un plan al agente y te lo leo en cuanto esté.'
          : "On it. I'll ask the agent for a plan and read it to you when it's ready.")
      );
    }
    return (
      degraded +
      (es
        ? `Va, se lo delego a ${this.providerLabel()}. Te aviso cuando termine.`
        : `On it — delegating to ${this.providerLabel()}. I'll let you know when it's done.`)
    );
  }

  private onTool(activity: ToolActivity): void {
    const label = say(activity.label, this.lastLanguageEs);
    this.tracker.addTool(label);
    this.log(`[agent] ${activity.name}: ${label}`);
    this.ui.tool({ id: activity.id, label, detail: activity.detail, state: 'running' });
    this.pushStatus();
    if (activity.filePath) {
      // Show the file the agent is writing, live, without stealing focus.
      void this.revealFile(activity.filePath);
    }
  }

  private onToolDone(activity: ToolActivity, result: { ok: boolean; output?: string }): void {
    this.ui.tool({
      id: activity.id,
      label: say(activity.label, this.lastLanguageEs),
      detail: activity.detail,
      state: result.ok ? 'ok' : 'error',
    });
    if (result.output === undefined) {
      return;
    }
    this.agentOutput.appendLine(`$ ${activity.detail ?? activity.name}`);
    this.agentOutput.appendLine(result.output.trim() ? result.output.trim() : '(no output)');
    this.agentOutput.appendLine('');
    if (!this.outputShown) {
      this.outputShown = true;
      this.agentOutput.show(true);
    }
  }

  private onPermissionRequest(request: PermissionRequest): void {
    this.pendingApprovals.push(request);
    const es = this.lastLanguageEs;
    const what = say(request.title, es);
    this.log(`[agent] permission request: ${what}`);
    this.ui.permission({ title: what, detail: request.detail, canRemember: request.canRemember });
    this.pushStatus();
    // Only the oldest request is announced: the rest are answered in turn, and
    // reading three prompts over each other is unusable by voice.
    if (this.pendingApprovals.length > 1) {
      return;
    }
    this.notify(es ? `El agente quiere ${what}. ¿Lo apruebo?` : `The agent wants to ${what}. Should I approve it?`);
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
      this.notify(es ? `Ahora quiere ${what}. ¿Lo apruebo?` : `Now it wants to ${what}. Should I approve it?`);
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

  /** Opens the file the agent is editing. Write announces the tool before the
   * file exists on disk, so keep retrying for a few seconds. */
  private async revealFile(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Reveals what the agent just inserted and washes it green for a moment. */
  private async highlightEdit(filePath: string, addedText?: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
      let range: vscode.Range;
      const needle = addedText?.trim();
      const index = needle ? doc.getText().indexOf(needle) : -1;
      if (needle && index >= 0) {
        range = new vscode.Range(doc.positionAt(index), doc.positionAt(index + needle.length));
      } else {
        // Unknown insertion point (some providers only report the path):
        // showing the file is honest; washing it all green is not.
        return;
      }
      editor.setDecorations(this.editDecoration, [range]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      // The write already happened; this animates its appearance so the user
      // sees the code "being typed" instead of materializing at once.
      await this.typewriter.play(editor, range);
      setTimeout(() => {
        for (const e of vscode.window.visibleTextEditors) {
          if (e.document.uri.toString() === doc.uri.toString()) {
            e.setDecorations(this.editDecoration, []);
          }
        }
      }, 5000);
    } catch {
      // file vanished or unreadable — nothing to show
    }
  }

  private onTurnComplete(resultText: string, isError: boolean): void {
    this.tracker.lastResult = resultText;
    this.pushStatus();
    const es = this.lastLanguageEs;
    if (isError) {
      this.notify(es ? `El agente terminó con un error: ${spoken(resultText).slice(0, 200)}` : `The agent hit an error: ${spoken(resultText).slice(0, 200)}`);
      return;
    }
    // Prefer the agent's dedicated spoken summary; fall back to the full text.
    const spokenMatch = resultText.match(/SPOKEN:\s*([\s\S]+)$/);
    const summary = spoken(spokenMatch ? spokenMatch[1] : resultText).slice(0, 600);
    if (this.session?.mode === 'plan') {
      this.notify(
        es
          ? `El plan está listo: ${summary} … Di "adelante" para ejecutarlo, o dime qué cambiar.`
          : `The plan is ready: ${summary} … Say "go ahead" to run it, or tell me what to change.`,
      );
    } else {
      this.notify(es ? `Listo. ${summary}` : `Done. ${summary}`);
    }
  }

  /** Spoken status from the tracker — answers "¿qué está haciendo?" without interrupting. */
  status(es: boolean): string {
    if (!this.active || !this.session) {
      return es ? 'No hay ninguna tarea delegada ahora mismo.' : 'No task is delegated right now.';
    }
    const pending = this.pendingApprovals[0];
    const doing = pending
      ? es
        ? `está esperando que apruebes: ${say(pending.title, true)}`
        : `is waiting for you to approve: ${say(pending.title, false)}`
      : this.session.state === 'ready'
        ? es
          ? 'terminó y espera instrucciones'
          : 'finished and is awaiting instructions'
        : es
          ? `sigue trabajando, lleva ${this.tracker.toolCount} acciones`
          : `is still working, ${this.tracker.toolCount} actions so far`;
    const last = this.tracker.recentTools.at(-1);
    // The last tool is a command line, not a sentence: name the action, and
    // leave the raw command to the panel.
    const latest = last ? (es ? ` Lo último: ${last}.` : ` Latest: ${last}.`) : '';
    return es ? `El agente ${doing}.${latest}` : `The agent ${doing}.${latest}`;
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
    if (transcript !== undefined && BLANKET_PATTERN.test(transcript)) {
      this.session?.approve({});
      // Announces failures itself via the log; the spoken reply below already
      // tells the user what happened and how to revert.
      void this.setPermissionLevel(es ? 'automático' : 'auto', es);
      return es
        ? 'Aprobado, y pongo al agente en automático: dejo de preguntarte. Di "modo manual" si quieres volver a aprobar cada paso.'
        : 'Approved — and I\'m switching the agent to auto, so I stop asking. Say "manual mode" to approve each step again.';
    }
    const remember = transcript !== undefined && REMEMBER_PATTERN.test(transcript);
    const canRemember = this.pendingApprovals[0]?.canRemember === true;
    this.session?.approve({ remember: remember && canRemember });
    if (remember && !canRemember) {
      return es
        ? 'Aprobado. Este agente no puede recordar la excepción, pero si quieres te lo pongo en automático y dejo de preguntarte.'
        : "Approved. This agent can't remember the exception, but I can put it on auto and stop asking you.";
    }
    if (remember) {
      return es ? 'Aprobado, y no te vuelvo a preguntar por esto.' : "Approved, and I won't ask about this again.";
    }
    return es ? 'Aprobado, el agente sigue.' : 'Approved — the agent continues.';
  }

  deny(es: boolean, transcript?: string): string {
    this.lastLanguageEs = es;
    if (!this.waitingApproval) {
      return this.steerInstead(es, transcript);
    }
    this.session?.deny();
    return es ? 'Denegado. El agente buscará otra forma o se detendrá.' : 'Denied. The agent will adapt or stop.';
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
    return es
      ? 'No había nada pendiente, así que se lo paso al agente como instrucción.'
      : "Nothing was pending, so I'm passing that to the agent as an instruction.";
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
    this.preferredMode = target.id;
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
      ? `Listo, nivel ${target.label}: ${target.summary}.`
      : `Done, ${target.labelEn} level: ${target.summaryEn}.`;
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
      const writing =
        this.modes().find((mode) => mode.id === this.preferredMode && mode.id !== 'plan') ??
        this.modes().find((mode) => mode.isDefault) ??
        this.modes().find((mode) => mode.id !== 'plan');
      if (writing) {
        await this.session.setMode(writing.id);
      }
    }
    this.session.send('The user approved the plan by voice. Proceed with the implementation now.');
    this.pushStatus();
    return es ? 'Adelante, el agente ejecuta el plan.' : 'Go — the agent is executing the plan.';
  }

  async stop(es: boolean): Promise<string> {
    if (!this.active || !this.session) {
      return es ? 'No hay ninguna tarea que detener.' : 'There is no task to stop.';
    }
    await this.session.interrupt();
    this.pendingApprovals.length = 0;
    this.ui.permission(undefined);
    this.pushStatus();
    return es ? 'Detenido. La sesión sigue viva por si quieres retomarla.' : 'Stopped. The session stays alive if you want to resume.';
  }

  dispose(): void {
    this.session?.dispose();
    this.session = undefined;
    this.typewriter.dispose();
    this.editDecoration.dispose();
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

function contextRoots(): { cwd: string; extraDirs: string[] } | undefined {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (folders.length === 0) {
    return undefined;
  }
  return { cwd: folders[0], extraDirs: folders.slice(1) };
}
