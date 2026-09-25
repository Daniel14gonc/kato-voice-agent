import * as vscode from 'vscode';

/** How long a step command waits for the debugger to report the new position. */
const STEP_WAIT_MS = 2_500;

/**
 * Ad-hoc launch configs by file extension, used when the workspace has no
 * launch.json. Anything not listed falls back to the workspace's own configs,
 * so any language debugs fine as long as its extension is set up.
 */
const ADHOC_CONFIGS: Record<string, (program: string) => vscode.DebugConfiguration> = {
  py: (program) => ({
    type: 'debugpy',
    request: 'launch',
    name: 'Kato debug',
    program,
    console: 'integratedTerminal',
    justMyCode: true,
  }),
  js: (program) => ({ type: 'node', request: 'launch', name: 'Kato debug', program }),
  mjs: (program) => ({ type: 'node', request: 'launch', name: 'Kato debug', program }),
  cjs: (program) => ({ type: 'node', request: 'launch', name: 'Kato debug', program }),
  ts: (program) => ({
    type: 'node',
    request: 'launch',
    name: 'Kato debug',
    program,
    runtimeExecutable: 'npx',
    runtimeArgs: ['tsx'],
  }),
  go: (program) => ({ type: 'go', request: 'launch', mode: 'debug', name: 'Kato debug', program }),
};

/** Split a container body on top-level commas ("1: 1, 2: [4, 5]" → 2 parts). */
function splitTop(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | undefined;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if ('{[('.includes(ch)) {
      depth++;
    } else if ('}])'.includes(ch)) {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

/**
 * TTS reads "{1: 1, 2: 4}" as "one one two four" — braces and colons are
 * silent, so container reprs are unintelligible spoken. Turn the common
 * shapes (dict/list/tuple/set) into sentences; anything else passes through.
 */
function speakableValue(raw: string, es: boolean): string {
  const value = raw.trim().slice(0, 400);
  const item = (entry: string) => entry.slice(0, 40);
  const listy = (body: string, kind: { es: string; en: string }) => {
    const items = splitTop(body);
    if (items.length === 0) {
      return es ? `${kind.es} vacía` : `an empty ${kind.en}`;
    }
    const head = items.slice(0, 6).map(item).join(', ');
    const more = items.length > 6 ? (es ? `, y ${items.length - 6} más` : `, and ${items.length - 6} more`) : '';
    return es
      ? `${kind.es} de ${items.length}: ${head}${more}`
      : `a ${kind.en} of ${items.length}: ${head}${more}`;
  };
  if (value.startsWith('{') && value.endsWith('}')) {
    const body = value.slice(1, -1).trim();
    if (!body) {
      return es ? 'un diccionario vacío' : 'an empty dictionary';
    }
    const entries = splitTop(body);
    if (entries.some((e) => e.includes(':'))) {
      const head = entries
        .slice(0, 6)
        .map((entry) => {
          const colon = entry.indexOf(':');
          const key = item(entry.slice(0, colon).trim());
          const val = item(entry.slice(colon + 1).trim());
          return es ? `${key} vale ${val}` : `${key} is ${val}`;
        })
        .join(', ');
      const more = entries.length > 6 ? (es ? `, y ${entries.length - 6} más` : `, and ${entries.length - 6} more`) : '';
      return es
        ? `un diccionario con ${entries.length} entrada${entries.length === 1 ? '' : 's'}: ${head}${more}`
        : `a dictionary with ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}: ${head}${more}`;
    }
    return listy(body, { es: 'un conjunto', en: 'set' });
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const body = value.slice(1, -1).trim();
    return body ? listy(body, { es: 'una lista', en: 'list' }) : es ? 'una lista vacía' : 'an empty list';
  }
  if (value.startsWith('(') && value.endsWith(')')) {
    const body = value.slice(1, -1).trim();
    return body ? listy(body, { es: 'una tupla', en: 'tuple' }) : es ? 'una tupla vacía' : 'an empty tuple';
  }
  return value.slice(0, 200);
}

const STEP_COMMANDS: Record<string, string> = {
  step_over: 'workbench.action.debug.stepOver',
  step_into: 'workbench.action.debug.stepInto',
  step_out: 'workbench.action.debug.stepOut',
  continue: 'workbench.action.debug.continue',
};

/**
 * Voice-driven control of the real VS Code debugger. Sessions, breakpoints and
 * stepping go through the standard debug UI, so everything is visible live;
 * a DAP tracker narrates stops (breakpoints, exceptions) as they happen.
 */
export class DebugController {
  private readonly disposables: vscode.Disposable[] = [];
  private paused: { file: string; line: number } | undefined;
  private lastStoppedThreadId: number | undefined;
  /** Set while a step command awaits its 'stopped' event, to mute notify(). */
  private stepWaiter: (() => void) | undefined;
  private lastEs = true;

  constructor(
    /** Speaks a spontaneous narration (breakpoint hit while running, etc.). */
    private readonly notify: (text: string) => void,
    private readonly log: (message: string) => void,
  ) {
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session) => ({
          onDidSendMessage: (message) => void this.onAdapterMessage(session, message),
        }),
      }),
      vscode.debug.onDidTerminateDebugSession(() => {
        this.paused = undefined;
        this.lastStoppedThreadId = undefined;
        if (this.stepWaiter) {
          this.stepWaiter();
        } else {
          this.notify(this.lastEs ? 'El debugger terminó.' : 'The debugger finished.');
        }
      }),
    );
  }

  /** Snapshot line so the router knows stepping/eval commands make sense now. */
  statusLine(): string {
    if (!vscode.debug.activeDebugSession) {
      return '';
    }
    const at = this.paused ? `paused at ${this.paused.file}:${this.paused.line}` : 'running';
    return (
      `DEBUG: session active, ${at} — "step/siguiente" → step_over, "continue/continúa" → continue, ` +
      `"what is X / cuánto vale X" → evaluate, "stop the debugger" → stop.`
    );
  }

  async start(fileHint: string | undefined, es: boolean): Promise<string> {
    this.lastEs = es;
    const uri = await this.resolveFile(fileHint);
    if (!uri) {
      return es
        ? 'No sé qué archivo debuggear: abre uno o dime su nombre.'
        : "I don't know which file to debug: open one or tell me its name.";
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
    const base = uri.path.split('/').pop() ?? uri.path;
    const ext = (base.split('.').pop() ?? '').toLowerCase();
    const adhoc = ADHOC_CONFIGS[ext];
    const workspaceConfigs =
      vscode.workspace.getConfiguration('launch', folder?.uri).get<vscode.DebugConfiguration[]>('configurations') ?? [];

    let config: vscode.DebugConfiguration | string | undefined;
    if (adhoc) {
      config = adhoc(uri.fsPath);
    } else if (workspaceConfigs.length > 0) {
      // Unknown extension: trust the project's own launch.json.
      config = workspaceConfigs[0].name;
    }
    if (!config) {
      return es
        ? `No sé lanzar un debugger para ${base} y el proyecto no tiene launch.json. Crea una configuración de debug y lo intento con ella.`
        : `I don't know how to debug ${base} and the project has no launch.json. Create a debug configuration and I'll use it.`;
    }
    const label = typeof config === 'string' ? config : base;
    try {
      const started = await vscode.debug.startDebugging(folder, config);
      if (!started) {
        return es
          ? `VS Code no pudo arrancar el debugger para ${label}. ¿Está instalada la extensión de ese lenguaje?`
          : `VS Code couldn't start the debugger for ${label}. Is that language's extension installed?`;
      }
    } catch (err) {
      return es
        ? `El debugger falló al arrancar: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`
        : `The debugger failed to start: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`;
    }
    const hasBreakpoints = vscode.debug.breakpoints.length > 0;
    return es
      ? `Debugger arrancado con ${label}.${hasBreakpoints ? ' Te aviso cuando pare en un breakpoint.' : ' No hay breakpoints: correrá hasta el final salvo que pare por una excepción.'}`
      : `Debugger started on ${label}.${hasBreakpoints ? " I'll tell you when it stops at a breakpoint." : ' There are no breakpoints, so it will run to the end unless an exception stops it.'}`;
  }

  async setBreakpoint(fileHint: string | undefined, line: number | undefined, es: boolean): Promise<string> {
    this.lastEs = es;
    const uri = await this.resolveFile(fileHint);
    if (!uri) {
      return es ? 'No sé en qué archivo poner el breakpoint.' : "I don't know which file to set the breakpoint in.";
    }
    const editor = vscode.window.activeTextEditor;
    const targetLine =
      line ?? (editor?.document.uri.toString() === uri.toString() ? editor.selection.active.line + 1 : undefined);
    if (!targetLine) {
      return es ? '¿En qué línea pongo el breakpoint?' : 'Which line should the breakpoint go on?';
    }
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(targetLine - 1, 0))),
    ]);
    const base = uri.path.split('/').pop();
    return es ? `Breakpoint en ${base}, línea ${targetLine}.` : `Breakpoint at ${base}, line ${targetLine}.`;
  }

  removeBreakpoints(es: boolean): string {
    this.lastEs = es;
    const count = vscode.debug.breakpoints.length;
    if (count === 0) {
      return es ? 'No hay breakpoints que quitar.' : 'There are no breakpoints to remove.';
    }
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    return es ? `Quité ${count} breakpoint${count === 1 ? '' : 's'}.` : `Removed ${count} breakpoint${count === 1 ? '' : 's'}.`;
  }

  async step(action: 'step_over' | 'step_into' | 'step_out' | 'continue', es: boolean): Promise<string> {
    this.lastEs = es;
    if (!vscode.debug.activeDebugSession) {
      return es ? 'No hay ninguna sesión de debug activa.' : 'There is no active debug session.';
    }
    // The narration comes from the resulting 'stopped' event, so the reply and
    // the debugger UI always agree on where execution actually is.
    const stopped = new Promise<void>((resolve) => {
      this.stepWaiter = resolve;
    });
    await vscode.commands.executeCommand(STEP_COMMANDS[action]);
    const timedOut = await Promise.race([
      stopped.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STEP_WAIT_MS)),
    ]);
    this.stepWaiter = undefined;
    if (!vscode.debug.activeDebugSession) {
      return es ? 'El programa terminó.' : 'The program finished.';
    }
    if (timedOut) {
      return es ? 'Sigue corriendo; te aviso cuando pare.' : "Still running — I'll tell you when it stops.";
    }
    return this.paused
      ? es
        ? `Línea ${this.paused.line} de ${this.paused.file}.`
        : `Line ${this.paused.line} of ${this.paused.file}.`
      : es
        ? 'Hecho.'
        : 'Done.';
  }

  async evaluate(expression: string, es: boolean): Promise<string> {
    this.lastEs = es;
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      return es ? 'No hay ninguna sesión de debug activa.' : 'There is no active debug session.';
    }
    if (!expression.trim()) {
      return es ? '¿Qué expresión evalúo?' : 'What expression should I evaluate?';
    }
    const frameId = await this.currentFrameId(session);
    if (frameId === undefined) {
      return es
        ? 'El programa no está pausado: para en un breakpoint y te leo lo que quieras.'
        : "The program isn't paused — stop at a breakpoint and I'll read anything you want.";
    }
    try {
      const res = await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
      const value = speakableValue(String(res?.result ?? ''), es);
      return es ? `${expression} vale ${value}` : `${expression} is ${value}`;
    } catch (err) {
      return es
        ? `No pude evaluar ${expression}: ${String(err instanceof Error ? err.message : err).slice(0, 100)}`
        : `Couldn't evaluate ${expression}: ${String(err instanceof Error ? err.message : err).slice(0, 100)}`;
    }
  }

  async stopSession(es: boolean): Promise<string> {
    this.lastEs = es;
    if (!vscode.debug.activeDebugSession) {
      return es ? 'No hay ningún debugger corriendo.' : 'There is no debugger running.';
    }
    await vscode.debug.stopDebugging();
    return es ? 'Debugger detenido.' : 'Debugger stopped.';
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async onAdapterMessage(session: vscode.DebugSession, message: unknown): Promise<void> {
    const msg = message as { type?: string; event?: string; body?: { threadId?: number; reason?: string } };
    if (msg.type !== 'event' || msg.event !== 'stopped') {
      return;
    }
    this.lastStoppedThreadId = msg.body?.threadId;
    try {
      const trace = await session.customRequest('stackTrace', {
        threadId: msg.body?.threadId,
        startFrame: 0,
        levels: 1,
      });
      const frame = trace?.stackFrames?.[0];
      if (!frame) {
        return;
      }
      // debugpy sometimes omits source.name; the path's basename is just as good.
      const file =
        frame.source?.name ??
        (frame.source?.path ? String(frame.source.path).split('/').pop() : undefined) ??
        (this.lastEs ? 'el programa' : 'the program');
      this.paused = { file: String(file), line: Number(frame.line ?? 0) };
      if (frame.source?.path) {
        const uri = vscode.Uri.file(frame.source.path);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true });
        const pos = new vscode.Position(Math.max(0, this.paused.line - 1), 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      if (this.stepWaiter) {
        // A step command is waiting to narrate this stop itself.
        this.stepWaiter();
        return;
      }
      const reason = msg.body?.reason;
      const where = `${this.paused.file}, ${this.lastEs ? 'línea' : 'line'} ${this.paused.line}`;
      if (reason === 'exception') {
        this.notify(this.lastEs ? `Excepción en ${where}.` : `Exception at ${where}.`);
      } else {
        this.notify(this.lastEs ? `Parado en ${where}.` : `Stopped at ${where}.`);
      }
    } catch (err) {
      this.log(`[debug] stackTrace failed: ${String(err)}`);
    }
  }

  /** Frame to evaluate in: the focused one, or the top of the stopped thread. */
  private async currentFrameId(session: vscode.DebugSession): Promise<number | undefined> {
    const item = vscode.debug.activeStackItem;
    if (item && 'frameId' in item && typeof item.frameId === 'number') {
      return item.frameId;
    }
    if (this.lastStoppedThreadId === undefined) {
      return undefined;
    }
    try {
      const trace = await session.customRequest('stackTrace', {
        threadId: this.lastStoppedThreadId,
        startFrame: 0,
        levels: 1,
      });
      const id = trace?.stackFrames?.[0]?.id;
      return typeof id === 'number' ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /** Same loose matching as spoken file navigation: variants, then best basename. */
  private async resolveFile(hint: string | undefined): Promise<vscode.Uri | undefined> {
    if (!hint?.trim()) {
      return vscode.window.activeTextEditor?.document.uri;
    }
    const said = hint.trim().toLowerCase().split('/').pop() ?? '';
    const stem = said.replace(/\.[a-z0-9]+$/, '');
    const variants = new Set(
      [said, stem, stem.replace(/\s+/g, '_'), stem.replace(/\s+/g, '-'), stem.replace(/\s+/g, '')].filter(Boolean),
    );
    for (const variant of variants) {
      const found = await vscode.workspace.findFiles(`**/*${variant}*`, '**/node_modules/**', 10);
      if (found.length > 0) {
        const exact = found.find((uri) => {
          const base = (uri.path.split('/').pop() ?? '').toLowerCase();
          return base === said || base.replace(/\.[a-z0-9]+$/, '') === stem;
        });
        return exact ?? found.sort((a, b) => a.path.length - b.path.length)[0];
      }
    }
    return vscode.window.activeTextEditor?.document.uri;
  }
}
