import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  AsyncQueue,
  type AgentCapabilities,
  type AgentMode,
  type AgentModeInfo,
  type AgentSession,
  type AgentSessionProvider,
  type AgentState,
  type PermissionDecision,
  type Spoken,
  type StartSessionOptions,
  type ToolActivity,
} from '../agentSession';

/** The SDK is ESM-only and our bundle is CJS: load it via native dynamic
 * import, kept out of esbuild's reach so import.meta inside the SDK works. */
const importSdk = new Function(
  'return import("@anthropic-ai/claude-agent-sdk")',
) as () => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>;

/**
 * `bypassPermissions` is reachable from the SDK (with
 * allowDangerouslySkipPermissions), but it stops `canUseTool` from being
 * called at all — Kato would go blind to what the agent is doing, which is the
 * opposite of what a voice supervisor needs. "auto" therefore stays on
 * acceptEdits and Kato auto-approves inside its own callback, keeping every
 * tool call visible and narratable.
 */
const PERMISSION_MODES: Record<string, PermissionMode> = {
  ask: 'default',
  plan: 'plan',
  agent: 'acceptEdits',
  auto: 'acceptEdits',
};

const MODES: AgentModeInfo[] = [
  {
    id: 'plan',
    label: 'plan',
    labelEn: 'plan',
    summary: 'solo lee el código y te propone un plan, no toca nada',
    summaryEn: 'it only reads the code and proposes a plan, touching nothing',
    aliases: ['modo plan', 'planning', 'planear', 'solo lectura', 'read only'],
  },
  {
    id: 'ask',
    label: 'manual',
    labelEn: 'manual',
    summary: 'te pido permiso por voz para cada acción, incluidas las ediciones',
    summaryEn: 'I ask your permission by voice for every action, edits included',
    aliases: ['modo manual', 'preguntame todo', 'pregúntame todo', 'ask', 'ask me everything'],
  },
  {
    id: 'agent',
    label: 'normal',
    labelEn: 'normal',
    summary: 'edita archivos libremente y solo te pregunto para comandos',
    summaryEn: 'it edits files freely and I only ask you about commands',
    aliases: ['modo normal', 'por defecto', 'default', 'edit', 'accept edits'],
    isDefault: true,
  },
  {
    id: 'auto',
    label: 'automático',
    labelEn: 'auto',
    summary: 'no te pregunto nada, pero sigo narrándote cada acción',
    summaryEn: "I don't ask you anything, but I still narrate every action",
    aliases: ['modo automatico', 'auto', 'automatic', 'no me preguntes', "don't ask me", 'yolo'],
  },
];

const APPROVAL_TIMEOUT_MS = 180_000;

/** Tools whose output is worth streaming into the agent output channel. */
const COMMAND_TOOLS = new Set(['Bash', 'BashOutput']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Live Claude Code session over the Agent SDK: streaming input (steering),
 * interrupt, permission modes, and canUseTool for spoken approvals. Auth
 * reuses the user's `claude` login; no API key flows through Kato.
 */
export class ClaudeCodeSessionProvider implements AgentSessionProvider {
  readonly name = 'claude-code';
  readonly label = 'Claude Code';
  readonly modes = MODES;
  readonly capabilities: AgentCapabilities = { liveSteering: true };

  constructor(private readonly log: (message: string) => void) {}

  startSession(options: StartSessionOptions): AgentSession {
    return new ClaudeCodeSession(options, this.log);
  }
}

interface PendingPermission {
  request: { id: string; toolName: string };
  resolve: (result: PermissionResult) => void;
  timer: NodeJS.Timeout;
  suggestions: PermissionUpdate[];
}

class ClaudeCodeSession implements AgentSession {
  mode: AgentMode;
  state: AgentState = 'starting';

  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly abort = new AbortController();
  private query: Query | undefined;
  /**
   * Keyed by tool_use id: the agent can ask for several permissions from a
   * single assistant message, and a one-slot field silently dropped all but
   * the last one (the others then died on the 180s timeout).
   */
  private readonly pending = new Map<string, PendingPermission>();
  /** tool_use id → activity, so tool_result frames can be attributed. */
  private readonly runningTools = new Map<string, ToolActivity & { newText?: string }>();

  constructor(
    private readonly options: StartSessionOptions,
    private readonly log: (message: string) => void,
  ) {
    this.mode = options.mode;
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const sdk = await importSdk();
      this.query = sdk.query({
        prompt: this.input,
        options: {
          cwd: this.options.cwd,
          additionalDirectories: this.options.extraDirs,
          permissionMode: permissionModeFor(this.mode),
          ...(this.options.model ? { model: this.options.model } : {}),
          abortController: this.abort,
          // The agent's own prose, streamed: without it the panel has nothing
          // to show between tool calls and the user cannot tell it is alive.
          includePartialMessages: true,
          canUseTool: (toolName, input, ctx) =>
            this.onPermission(toolName, input, {
              description: ctx.description,
              toolUseID: ctx.toolUseID,
              suggestions: ctx.suggestions,
            }),
          env: {
            ...process.env,
            // The extension host may have a stripped PATH (launched from the
            // Dock); make sure the SDK can find `node`.
            PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`,
          },
          stderr: (data) => this.log(`[agent stderr] ${data.slice(0, 200)}`),
        },
      });
      for await (const message of this.query) {
        this.handleMessage(message);
      }
    } catch (err) {
      if (!this.abort.signal.aborted) {
        this.state = 'closed';
        this.options.events.onError(String(err instanceof Error ? err.message : err));
      }
    }
    if (this.state !== 'closed') {
      this.state = 'closed';
    }
  }

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.log(`[agent] session ${message.session_id} (${message.model})`);
          if (this.state === 'starting') {
            this.state = 'working';
          }
        }
        break;
      case 'stream_event': {
        // Text deltas only: this is what makes the panel feel alive between
        // tool calls. Subagent chatter would flood it.
        if (message.parent_tool_use_id !== null) {
          break;
        }
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          this.options.events.onAgentText?.(event.delta.text);
        }
        break;
      }
      case 'assistant': {
        // Top-level only: subagent chatter would flood the narration.
        if (message.parent_tool_use_id !== null) {
          break;
        }
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            const input = block.input as Record<string, unknown>;
            const activity: ToolActivity & { newText?: string } = {
              id: block.id,
              name: block.name,
              label: describeTool(block.name, input),
              detail: toolDetail(input),
              filePath:
                EDIT_TOOLS.has(block.name) && typeof input.file_path === 'string'
                  ? input.file_path
                  : undefined,
              newText:
                block.name === 'Edit'
                  ? String(input.new_string ?? '')
                  : block.name === 'Write'
                    ? String(input.content ?? '')
                    : undefined,
            };
            this.runningTools.set(block.id, activity);
            this.options.events.onTool(activity);
          }
        }
        break;
      }
      case 'user': {
        // Tool results come back as user messages; attribute them by id.
        if (message.parent_tool_use_id !== null) {
          break;
        }
        const content = message.message.content;
        if (!Array.isArray(content)) {
          break;
        }
        for (const block of content) {
          if (block.type !== 'tool_result') {
            continue;
          }
          const activity = this.runningTools.get(block.tool_use_id);
          if (!activity) {
            continue;
          }
          this.runningTools.delete(block.tool_use_id);
          const ok = block.is_error !== true;
          this.options.events.onToolDone?.(activity, {
            ok,
            output: COMMAND_TOOLS.has(activity.name) ? extractResultText(block.content) : undefined,
          });
          if (activity.filePath && ok) {
            this.options.events.onFileEdited?.(activity.filePath, activity.newText);
          }
        }
        break;
      }
      case 'result': {
        this.state = 'ready';
        const text = message.subtype === 'success' ? message.result : `(${message.subtype})`;
        this.options.events.onTurnComplete(text, message.is_error);
        break;
      }
      default:
        break;
    }
  }

  private onPermission(
    toolName: string,
    input: Record<string, unknown>,
    ctx: {
      description?: string;
      toolUseID: string;
      suggestions?: PermissionUpdate[];
    },
  ): Promise<PermissionResult> {
    // AskUserQuestion has no voice surface: approving it would park the agent
    // on a UI Kato cannot render. Speak the question and send it back as text.
    if (toolName === 'AskUserQuestion') {
      const asked = parseQuestion(input);
      if (asked) {
        this.options.events.onQuestion?.(asked.question, asked.options);
        return Promise.resolve({
          behavior: 'deny',
          message:
            'This session is driven by voice and has no interactive question UI. ' +
            'Ask the user in plain text in your reply instead; their answer arrives as the next message.',
        });
      }
    }

    if (this.mode === 'auto') {
      this.log(`[agent] auto-approved ${toolName}`);
      return Promise.resolve({ behavior: 'allow' });
    }

    const id = ctx.toolUseID;
    this.state = 'waiting_approval';
    this.options.events.onPermissionRequest({
      id,
      toolName,
      title: describeTool(toolName, input),
      detail: ctx.description ?? toolDetail(input),
      canRemember: (ctx.suggestions?.length ?? 0) > 0,
    });
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(id, {
          behavior: 'deny',
          message: 'No voice approval arrived in time; skip this action or try something else.',
        });
      }, APPROVAL_TIMEOUT_MS);
      this.pending.set(id, {
        request: { id, toolName },
        resolve,
        timer,
        suggestions: ctx.suggestions ?? [],
      });
    });
  }

  /** Resolves one pending request and re-derives the session state. */
  private settle(id: string, result: PermissionResult): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
    this.options.events.onPermissionResolved?.(id);
    if (this.pending.size === 0 && this.state === 'waiting_approval') {
      this.state = 'working';
    }
  }

  /** The request a bare spoken "sí" refers to: the oldest one still waiting. */
  private target(decision?: PermissionDecision): PendingPermission | undefined {
    if (decision?.id) {
      return this.pending.get(decision.id);
    }
    return this.pending.values().next().value;
  }

  send(instruction: string): void {
    this.state = 'working';
    this.input.push({
      type: 'user',
      message: { role: 'user', content: instruction },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.mode = mode;
    await this.query?.setPermissionMode(permissionModeFor(mode));
    // Switching to auto with requests already parked would otherwise leave the
    // agent waiting for approvals the user just said they never want again.
    if (mode === 'auto') {
      for (const id of [...this.pending.keys()]) {
        this.settle(id, { behavior: 'allow' });
      }
    }
  }

  approve(decision?: PermissionDecision): void {
    const entry = this.target(decision);
    if (!entry) {
      return;
    }
    // `suggestions` are the SDK's own "always allow" rules — the same ones
    // Claude Code shows as a button. Passing them back stops the re-asking.
    const remember = decision?.remember === true && entry.suggestions.length > 0;
    this.settle(entry.request.id, {
      behavior: 'allow',
      ...(remember ? { updatedPermissions: entry.suggestions } : {}),
    });
  }

  deny(reason?: string, decision?: PermissionDecision): void {
    const entry = this.target(decision);
    if (!entry) {
      return;
    }
    this.settle(entry.request.id, {
      behavior: 'deny',
      message: reason ?? 'The user declined by voice.',
    });
  }

  async interrupt(): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { behavior: 'deny', message: 'Interrupted by the user.' });
    }
    try {
      await this.query?.interrupt();
    } catch {
      // already finished — nothing to interrupt
    }
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { behavior: 'deny', message: 'The session was closed.' });
    }
    this.input.close();
    this.abort.abort();
    this.state = 'closed';
  }
}

function permissionModeFor(mode: AgentMode): PermissionMode {
  return PERMISSION_MODES[mode] ?? 'acceptEdits';
}

/**
 * A speakable one-liner for a tool call, in both languages. The old version
 * said "the agent wants to use Bash" for everything, so approvals were blind —
 * the user had no idea whether it was `git diff` or `git rm -f`.
 */
/**
 * A shell one-liner is panel material, not speech: pipes, redirections and
 * fallback chains sound like garbage through TTS. Reduce it to its head
 * command — first real segment of any &&/||/;/| chain (skipping a leading
 * `cd`), env prefixes and parens stripped, flags and redirections dropped,
 * paths cut to their basename — and say whether more was chained after it.
 */
function speakableCommand(command: string): { text: string; chained: boolean } {
  const segments = command
    .trim()
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .filter(Boolean);
  let head = segments[0] ?? command;
  if (/^\(*\s*cd\s/.test(head) && segments.length > 1) {
    head = segments[1];
  }
  head = head.replace(/^[(\s]+/, '').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
  const words: string[] = [];
  for (const raw of head.split(/\s+/)) {
    const token = raw.replace(/[()]/g, '');
    if (!token || token.startsWith('-') || /^\d*>&?\d*$/.test(token)) {
      continue;
    }
    words.push(token.includes('/') ? (token.split('/').filter(Boolean).pop() ?? token) : token);
    if (words.length === 3) {
      break;
    }
  }
  return { text: words.join(' ') || shorten(command, 40), chained: segments.length > 1 };
}

function describeTool(name: string, input: Record<string, unknown>): Spoken {
  const command = typeof input.command === 'string' ? input.command : undefined;
  const file = typeof input.file_path === 'string' ? shortPath(input.file_path) : undefined;
  switch (name) {
    case 'Bash': {
      if (!command) {
        return { es: 'correr un comando', en: 'run a command' };
      }
      const { text, chained } = speakableCommand(command);
      return {
        es: `correr ${text}${chained ? ', entre otros' : ''}`,
        en: `run ${text}${chained ? ', among others' : ''}`,
      };
    }
    case 'Read':
      return { es: `leer ${file ?? 'un archivo'}`, en: `read ${file ?? 'a file'}` };
    case 'Write':
      return { es: `crear ${file ?? 'un archivo'}`, en: `create ${file ?? 'a file'}` };
    case 'Edit':
    case 'MultiEdit':
      return { es: `editar ${file ?? 'un archivo'}`, en: `edit ${file ?? 'a file'}` };
    case 'NotebookEdit':
      return { es: `editar el notebook ${file ?? ''}`.trim(), en: `edit the notebook ${file ?? ''}`.trim() };
    case 'Grep': {
      const pattern = shorten(String(input.pattern ?? ''), 60);
      return { es: `buscar ${pattern}`, en: `search for ${pattern}` };
    }
    case 'Glob': {
      const pattern = shorten(String(input.pattern ?? ''), 60);
      return { es: `listar archivos ${pattern}`, en: `list files ${pattern}` };
    }
    case 'WebFetch': {
      const url = shorten(String(input.url ?? ''), 80);
      return { es: `abrir ${url}`, en: `open ${url}` };
    }
    case 'WebSearch': {
      const query = shorten(String(input.query ?? ''), 60);
      return { es: `buscar en la web ${query}`, en: `search the web for ${query}` };
    }
    case 'Task': {
      const description = shorten(String(input.description ?? ''), 60);
      return { es: `lanzar un subagente: ${description}`, en: `launch a subagent: ${description}` };
    }
    default: {
      const pretty = prettyToolName(name);
      const target = shorten(String(input.description ?? input.pattern ?? input.query ?? ''), 60);
      const suffix = target ? `: ${target}` : '';
      return { es: `usar ${pretty}${suffix}`, en: `use ${pretty}${suffix}` };
    }
  }
}

/** Raw target for the panel (never read aloud verbatim). */
function toolDetail(input: Record<string, unknown>): string | undefined {
  const candidate = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query;
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}

/** `mcp__playwright__browser_resize` → "playwright browser resize". */
function prettyToolName(name: string): string {
  return name.replace(/^mcp__/, '').replace(/__/g, ' ').replace(/_/g, ' ');
}

function shortPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts.slice(-2).join('/');
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Pulls the first question (and its option labels) out of an AskUserQuestion input. */
function parseQuestion(
  input: Record<string, unknown>,
): { question: string; options: string[] } | undefined {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return undefined;
  }
  const first = questions[0] as { question?: unknown; options?: unknown };
  if (typeof first?.question !== 'string') {
    return undefined;
  }
  const options = Array.isArray(first.options)
    ? first.options
        .map((option) =>
          option && typeof option === 'object' && 'label' in option ? String(option.label) : '',
        )
        .filter(Boolean)
    : [];
  return { question: first.question, options };
}

/** tool_result content can be a string or an array of content blocks. */
function extractResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
