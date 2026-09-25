/**
 * M3: agent-agnostic delegation layer with live sessions. One adapter per
 * coding agent (Claude Code first, Codex later). The voice layer only ever
 * talks to these interfaces; capability flags and the per-provider mode
 * catalog let it degrade gracefully — and let Kato *say out loud* what the
 * current agent can actually do instead of pretending every agent is alike.
 */

/**
 * Kato's canonical permission levels. Providers map these onto whatever they
 * really have (Claude Code: permission modes; Codex: sandbox scopes) and may
 * expose extra ids of their own — hence the open string type. Nothing outside
 * a provider should assume the set is closed; ask `AgentSessionProvider.modes`.
 */
export type AgentMode = 'ask' | 'plan' | 'agent' | 'auto' | (string & {});

export type AgentState = 'starting' | 'working' | 'waiting_approval' | 'ready' | 'closed';

/**
 * A phrase Kato may have to speak in either language. Providers build both
 * halves because only they know what the tool call actually was; the voice
 * layer picks one at the last moment, from the language of the utterance.
 */
export interface Spoken {
  es: string;
  en: string;
}

export function say(phrase: Spoken, es: boolean): string {
  return es ? phrase.es : phrase.en;
}

/**
 * One entry of a provider's permission-level catalog. Kato reads these aloud
 * ("¿qué modos tienes?") and matches the user's words against them, so every
 * field here is written to be spoken, not printed.
 */
export interface AgentModeInfo {
  id: AgentMode;
  /** Spoken name in Spanish, e.g. "automático". */
  label: string;
  /** Spoken name in English, e.g. "auto". */
  labelEn: string;
  /** One spoken sentence: what this level actually allows. */
  summary: string;
  summaryEn: string;
  /** Extra phrases that should resolve to this mode (matched case-insensitively). */
  aliases: string[];
  /** The level used when the user delegates without asking for one. */
  isDefault?: boolean;
}

/**
 * What is left after the mode catalog took over: "can it plan?" and "can it ask
 * per tool?" are now answered by `modes`, and "can it remember an approval?" by
 * each request's `canRemember`. Only turn semantics remain a real capability.
 */
export interface AgentCapabilities {
  /** False when a turn is atomic and mid-turn input is queued, not injected. */
  liveSteering: boolean;
}

export interface PermissionRequest {
  /** Opaque id so a decision lands on the request it was meant for. */
  id: string;
  toolName: string;
  /** Spoken prompt, e.g. "quiere correr git push origin main". */
  title: Spoken;
  /** Raw detail (shell command, file path) for the panel — not read aloud verbatim. */
  detail?: string;
  /** True when "sí, y no me preguntes más" can be honoured for this request. */
  canRemember: boolean;
}

/** How a permission request was resolved. */
export interface PermissionDecision {
  /** Target request; omitted = the oldest pending one. */
  id?: string;
  /** Remember the decision for the rest of the session ("no me preguntes más"). */
  remember?: boolean;
}

/** A tool call, from announcement to result — the panel's unit of activity. */
export interface ToolActivity {
  id: string;
  /** Tool name as the agent calls it, e.g. "Bash", "Edit". */
  name: string;
  /** Speakable one-liner, e.g. "correr los tests". */
  label: Spoken;
  /** Raw target (command, path, pattern) for the panel. */
  detail?: string;
  filePath?: string;
}

export interface AgentSessionEvents {
  /** A tool started. */
  onTool(activity: ToolActivity): void;
  /** That tool finished. `output` is set for command-like tools. */
  onToolDone?(activity: ToolActivity, result: { ok: boolean; output?: string }): void;
  /** The agent's own prose, streamed. Panel-only — TTS speaks the summary. */
  onAgentText?(delta: string): void;
  /** A file edit completed; `addedText` is the content the agent inserted. */
  onFileEdited?(filePath: string, addedText?: string): void;
  /** A turn finished; `resultText` is the agent's final text for that turn. */
  onTurnComplete(resultText: string, isError: boolean): void;
  /** The agent wants permission for a tool (Ask mode / guarded tools). */
  onPermissionRequest(request: PermissionRequest): void;
  /** A pending request stopped being pending (answered, timed out, cancelled). */
  onPermissionResolved?(id: string): void;
  /** The agent asked the user a question in a way Kato must voice itself. */
  onQuestion?(question: string, options: string[]): void;
  onError(message: string): void;
}

export interface AgentSession {
  readonly mode: AgentMode;
  readonly state: AgentState;
  /** Sends a task or steering instruction into the session. */
  send(instruction: string): void;
  setMode(mode: AgentMode): Promise<void>;
  /** Resolve a pending permission request. */
  approve(decision?: PermissionDecision): void;
  deny(reason?: string, decision?: PermissionDecision): void;
  interrupt(): Promise<void>;
  dispose(): void;
}

export interface StartSessionOptions {
  cwd: string;
  extraDirs: string[];
  model?: string;
  mode: AgentMode;
  events: AgentSessionEvents;
}

export interface AgentSessionProvider {
  readonly name: string;
  /** Spoken name, e.g. "Claude Code". */
  readonly label: string;
  readonly capabilities: AgentCapabilities;
  /** Permission levels this agent really supports, in the order Kato lists them. */
  readonly modes: AgentModeInfo[];
  startSession(options: StartSessionOptions): AgentSession;
}

/**
 * Resolves what the user said ("ponlo en automático", "auto mode", "plan")
 * against a provider's catalog. Returns undefined when nothing matches, so the
 * caller can read the real options aloud instead of guessing.
 */
export function resolveMode(modes: AgentModeInfo[], spokenText: string): AgentModeInfo | undefined {
  const text = normalize(spokenText);
  // Longest match wins: "modo manual" must beat a bare "manual" that another
  // entry also lists as an alias.
  let best: { mode: AgentModeInfo; length: number } | undefined;
  for (const mode of modes) {
    // Ids are internal identifiers, never words the user says: matching them
    // made "set auto permissions for the agent" resolve to the `agent` mode.
    for (const needle of [mode.label, mode.labelEn, ...mode.aliases]) {
      const normalized = normalize(needle);
      if (normalized && text.includes(normalized) && (!best || normalized.length > best.length)) {
        best = { mode, length: normalized.length };
      }
    }
  }
  return best?.mode;
}

/** Lowercase and strip accents, so "automático" matches "automatico". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Unbounded push-queue exposed as an AsyncIterable (SDK streaming input). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
