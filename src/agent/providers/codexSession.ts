import type { Codex, SandboxMode, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import type { AgentExploreRequest, AgentProvider } from '../agentProvider';
import { CODEX_MISSING, resolveCodexCli } from '../cliPaths';
import type {
  AgentCapabilities,
  AgentMode,
  AgentModeInfo,
  AgentSession,
  AgentSessionProvider,
  AgentState,
  PermissionDecision,
  Spoken,
  StartSessionOptions,
} from '../agentSession';

/** ESM-only package in a CJS bundle: load it with a real dynamic import. */
const importSdk = new Function('return import("@openai/codex-sdk")') as () => Promise<
  typeof import('@openai/codex-sdk')
>;

/**
 * Codex thread → sandbox mapping. Codex has no per-tool approval callback, so
 * permission levels become sandbox scopes: the sandbox enforces the boundary
 * instead of asking the user each time.
 */
const SANDBOX_MAP: Record<string, SandboxMode> = {
  plan: 'read-only',
  agent: 'workspace-write',
  auto: 'danger-full-access',
};

/**
 * Codex's catalog is deliberately shorter than Claude Code's: there is no
 * per-tool approval callback, so a "manual" level would be a lie. Kato reads
 * these out when the user asks what the current agent can do, which is the
 * whole point of keeping the catalog per provider instead of global.
 */
const MODES: AgentModeInfo[] = [
  {
    id: 'plan',
    label: 'plan',
    labelEn: 'plan',
    summary: 'sandbox de solo lectura: explora y propone, no escribe nada',
    summaryEn: 'a read-only sandbox: it explores and proposes, writing nothing',
    aliases: ['modo plan', 'solo lectura', 'read only', 'planear'],
  },
  {
    id: 'agent',
    label: 'normal',
    labelEn: 'normal',
    summary: 'sandbox del proyecto: escribe dentro del workspace y nada fuera',
    summaryEn: 'a workspace sandbox: it writes inside the project and nowhere else',
    aliases: ['modo normal', 'workspace', 'sandbox', 'default', 'por defecto'],
    isDefault: true,
  },
  {
    id: 'auto',
    label: 'automático',
    labelEn: 'auto',
    summary: 'acceso total, sin sandbox y sin preguntar nada',
    summaryEn: 'full access, no sandbox and no questions',
    aliases: ['modo automatico', 'auto', 'acceso total', 'full access', 'no me preguntes'],
  },
];

/**
 * Codex adapter. Second implementation of AgentSessionProvider, and the proof
 * that the voice layer isn't tied to one agent: capability flags tell Kato
 * what to degrade (no live steering mid-turn, no spoken per-tool approvals).
 */
export class CodexSessionProvider implements AgentSessionProvider {
  readonly name = 'codex';
  readonly label = 'Codex';
  readonly modes = MODES;
  // Turns are atomic: an instruction sent mid-turn is queued, not injected.
  readonly capabilities: AgentCapabilities = { liveSteering: false };

  constructor(private readonly log: (message: string) => void) {}

  startSession(options: StartSessionOptions): AgentSession {
    return new CodexSession(options, this.log);
  }
}

class CodexSession implements AgentSession {
  mode: AgentMode;
  state: AgentState = 'starting';

  private codex: Codex | undefined;
  private thread: Thread | undefined;
  private threadId: string | undefined;
  private turnAbort: AbortController | undefined;
  private running = false;
  private disposed = false;
  private readonly queue: string[] = [];

  constructor(
    private readonly options: StartSessionOptions,
    private readonly log: (message: string) => void,
  ) {
    this.mode = options.mode;
  }

  private threadOptions(): ThreadOptions {
    return {
      workingDirectory: this.options.cwd,
      additionalDirectories: this.options.extraDirs,
      ...(this.options.model ? { model: this.options.model } : {}),
      sandboxMode: SANDBOX_MAP[this.mode] ?? 'workspace-write',
      // Never block on stdin approvals: nothing could answer them.
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    };
  }

  private async ensureThread(): Promise<Thread> {
    if (!this.codex) {
      const sdk = await importSdk();
      this.codex = newCodex(sdk);
    }
    if (!this.thread) {
      this.thread = this.threadId
        ? this.codex.resumeThread(this.threadId, this.threadOptions())
        : this.codex.startThread(this.threadOptions());
    }
    return this.thread;
  }

  send(instruction: string): void {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      // Codex turns are atomic — queue instead of interleaving.
      this.queue.push(instruction);
      this.log('[agent] codex is mid-turn; queued the instruction for the next turn');
      return;
    }
    void this.runTurn(instruction);
  }

  private async runTurn(instruction: string): Promise<void> {
    this.running = true;
    this.state = 'working';
    const abort = new AbortController();
    this.turnAbort = abort;
    let finalText = '';
    try {
      const thread = await this.ensureThread();
      const turn = await thread.runStreamed(instruction, { signal: abort.signal });
      for await (const event of turn.events) {
        finalText = this.handleEvent(event, finalText);
      }
      if (!abort.signal.aborted) {
        this.state = 'ready';
        this.options.events.onTurnComplete(finalText, false);
      }
    } catch (err) {
      if (!abort.signal.aborted && !this.disposed) {
        this.state = 'ready';
        this.options.events.onError(codexError(err));
      }
    } finally {
      this.running = false;
      this.turnAbort = undefined;
    }
    const next = this.queue.shift();
    if (next && !this.disposed) {
      void this.runTurn(next);
    }
  }

  private handleEvent(event: ThreadEvent, finalText: string): string {
    switch (event.type) {
      case 'thread.started':
        this.threadId = event.thread_id;
        this.log(`[agent] codex thread ${event.thread_id}`);
        return finalText;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item;
        if (item.type === 'todo_list') {
          // Codex only marks items done; the first open one is the current step.
          const current = item.items.findIndex((todo) => !todo.completed);
          this.options.events.onTodos?.(
            item.items.map((todo, index) => ({
              id: String(index + 1),
              text: todo.text,
              status: todo.completed ? 'completed' : index === current ? 'in_progress' : 'pending',
            })),
          );
          return finalText;
        }
        if (event.type === 'item.updated') {
          return finalText;
        }
        if (item.type === 'command_execution') {
          const command = item.command.slice(0, 120);
          const activity = {
            id: item.id,
            name: 'Bash',
            label: { es: `correr ${command}`, en: `run ${command}` },
            detail: item.command,
          };
          if (event.type === 'item.started') {
            this.options.events.onTool(activity);
          } else {
            this.options.events.onToolDone?.(activity, {
              ok: item.status !== 'failed',
              output: item.aggregated_output ?? '',
            });
          }
        } else if (item.type === 'file_change' && event.type === 'item.completed') {
          for (const change of item.changes) {
            const activity = {
              id: `${item.id}:${change.path}`,
              name: changeTool(change.kind),
              label: changeLabel(change.kind, change.path),
              detail: change.path,
              filePath: change.path,
            };
            this.options.events.onTool(activity);
            this.options.events.onToolDone?.(activity, { ok: item.status === 'completed' });
            if (item.status === 'completed') {
              this.options.events.onFileEdited?.(change.path);
            }
          }
        } else if (item.type === 'agent_message' && event.type === 'item.completed') {
          return item.text;
        } else if (item.type === 'error' && event.type === 'item.completed') {
          this.options.events.onError(item.message);
        }
        return finalText;
      }
      case 'turn.failed':
        this.options.events.onError(event.error?.message ?? 'Codex turn failed');
        return finalText;
      default:
        return finalText;
    }
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.mode = mode;
    // Thread options are fixed at creation; rebuild from the thread id so the
    // conversation survives the sandbox change.
    this.thread = undefined;
    if (this.codex && this.threadId) {
      this.thread = this.codex.resumeThread(this.threadId, this.threadOptions());
    }
  }

  approve(_decision?: PermissionDecision): void {
    // No-op: Codex never asks — its catalog has no per-tool approval level.
  }

  deny(_reason?: string, _decision?: PermissionDecision): void {
    // No-op — see approve().
  }

  async interrupt(): Promise<void> {
    this.queue.length = 0;
    this.turnAbort?.abort();
    this.running = false;
    this.state = 'ready';
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.turnAbort?.abort();
    this.state = 'closed';
  }
}

/**
 * Codex in read-only mode for deep understanding (repo exploration + tour).
 * Same contract as the Claude Code explorer, so kato.agent.provider switches
 * both delegation and exploration together.
 */
export class CodexExploreAgent implements AgentProvider {
  readonly name = 'codex';

  async runReadOnly(request: AgentExploreRequest): Promise<string> {
    const sdk = await importSdk();
    const codex = newCodex(sdk);
    const thread = codex.startThread({
      workingDirectory: request.cwd,
      additionalDirectories: request.extraDirs,
      ...(request.model ? { model: request.model } : {}),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    });
    let finalText = '';
    try {
      const turn = await thread.runStreamed(request.prompt, { signal: request.signal });
      for await (const event of turn.events) {
        if (event.type !== 'item.completed') {
          continue;
        }
        if (event.item.type === 'agent_message') {
          finalText = event.item.text;
        } else if (event.item.type === 'command_execution') {
          request.onProgress?.(`Bash ${event.item.command.slice(0, 80)}`);
          const head = event.item.command.slice(0, 60);
          request.onActivity?.({
            id: event.item.id,
            name: 'Bash',
            label: { es: `revisar con ${head}`, en: `inspect with ${head}` },
            detail: event.item.command,
          });
        } else if (event.item.type === 'error') {
          throw new Error(event.item.message);
        }
      }
    } catch (err) {
      throw new Error(codexError(err));
    }
    if (!finalText) {
      throw new Error('Codex no devolvió respuesta.');
    }
    return finalText;
  }
}

function changeTool(kind: 'add' | 'delete' | 'update'): string {
  return kind === 'add' ? 'Write' : kind === 'delete' ? 'Delete' : 'Edit';
}

function changeLabel(kind: 'add' | 'delete' | 'update', path: string): Spoken {
  const short = path.split('/').slice(-2).join('/');
  if (kind === 'add') {
    return { es: `crear ${short}`, en: `create ${short}` };
  }
  if (kind === 'delete') {
    return { es: `borrar ${short}`, en: `delete ${short}` };
  }
  return { es: `editar ${short}`, en: `edit ${short}` };
}

/** Drives the user's installed `codex` when there is one (the packaged extension bundles no binary). */
function newCodex(sdk: typeof import('@openai/codex-sdk')): Codex {
  const cli = resolveCodexCli();
  return new sdk.Codex(cli ? { codexPathOverride: cli } : {});
}

function codexError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!resolveCodexCli() && /ENOENT|not found|unable to locate|binary/i.test(message)) {
    return CODEX_MISSING;
  }
  if (/ENOENT|not found|login|auth/i.test(message)) {
    return `${message} — puede que necesites autenticarte con "codex login".`;
  }
  return message;
}
