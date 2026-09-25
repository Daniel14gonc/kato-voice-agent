import * as vscode from 'vscode';
import { getConfig } from '../config';
import type { LlmProvider } from '../llm/llmProvider';

const COMMAND_KEY = 'kato.testCommand';
const MAX_CAPTURE = 20_000;
const SHELL_INTEGRATION_TIMEOUT_MS = 5000;

interface LastRun {
  command: string;
  exitCode: number | undefined;
  output: string;
}

/**
 * Runs the project's tests in a real terminal (so the user sees them) while
 * capturing the output via the Terminal Shell Integration API, then turns
 * failures into a spoken summary.
 */
export class TestRunner {
  private terminal: vscode.Terminal | undefined;
  private lastRun: LastRun | undefined;
  private running = false;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly llm: LlmProvider,
    private readonly log: (message: string) => void,
    /** Speaks a spontaneous notification when the run finishes. */
    private readonly notify: (text: string) => void,
  ) {}

  /** Snapshot line so follow-ups ("¿qué falló?") have the last result. */
  statusLine(): string {
    if (this.running) {
      return 'TESTS: a test run is in progress right now.';
    }
    if (!this.lastRun) {
      return '';
    }
    const verdict = this.lastRun.exitCode === 0 ? 'passed' : `failed (exit ${this.lastRun.exitCode})`;
    return (
      `TESTS: last run "${this.lastRun.command}" ${verdict}. Tail of the output ` +
      `(use it to answer questions about what failed):\n${tail(this.lastRun.output, 1500)}`
    );
  }

  /** Starts a run; returns the spoken acknowledgment. Completion is notified. */
  async start(es: boolean): Promise<string> {
    if (this.running) {
      return es ? 'Ya hay una corrida de tests en curso.' : 'A test run is already in progress.';
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return es ? 'No hay proyecto abierto donde correr tests.' : 'There is no open project to run tests in.';
    }
    const command = await this.resolveCommand(folder.uri);
    if (!command) {
      return es
        ? 'No supe qué comando corre los tests aquí. Dime cuál es y lo recuerdo.'
        : "I couldn't tell which command runs the tests here. Tell me and I'll remember it.";
    }
    this.running = true;
    void this.execute(command, es);
    return es ? `Corriendo ${command}. Te aviso cómo va.` : `Running ${command}. I'll tell you how it goes.`;
  }

  private async execute(command: string, es: boolean): Promise<void> {
    try {
      const terminal = await this.ensureTerminal();
      terminal.show(true);
      const integration = await this.waitForShellIntegration(terminal);
      if (!integration) {
        terminal.sendText(command);
        this.running = false;
        this.notify(
          es
            ? 'Lancé los tests en la terminal, pero no pude capturar la salida para resumírtela.'
            : "I started the tests in the terminal, but I couldn't capture the output to summarize it.",
        );
        return;
      }

      const execution = integration.executeCommand(command);
      const ended = new Promise<number | undefined>((resolve) => {
        const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
          if (event.execution === execution) {
            disposable.dispose();
            resolve(event.exitCode);
          }
        });
      });
      let output = '';
      for await (const chunk of execution.read()) {
        output += chunk;
        if (output.length > MAX_CAPTURE) {
          output = output.slice(-MAX_CAPTURE);
        }
      }
      const exitCode = await ended;
      this.lastRun = { command, exitCode, output: stripAnsi(output) };
      this.running = false;
      this.log(`[tests] ${command} exited ${exitCode}`);
      this.notify(await this.summarize(es));
    } catch (err) {
      this.running = false;
      this.log(`[tests error] ${String(err)}`);
      this.notify(
        es ? `No pude correr los tests: ${String(err)}` : `I couldn't run the tests: ${String(err)}`,
      );
    }
  }

  private async summarize(es: boolean): Promise<string> {
    const run = this.lastRun;
    if (!run) {
      return es ? 'La corrida terminó.' : 'The run finished.';
    }
    if (run.exitCode === 0) {
      return es ? 'Listo, los tests pasaron.' : 'Done — the tests passed.';
    }
    try {
      let summary = '';
      await this.llm.streamChat({
        model: getConfig().explainerModel,
        messages: [
          {
            role: 'system',
            content:
              'You summarize test output for a voice assistant. Say how many tests failed and name the first ' +
              'one or two failures with their cause, in 1-3 short spoken sentences. No markdown, no lists, no code blocks.',
          },
          {
            role: 'user',
            content: `Command: ${run.command}\nExit code: ${run.exitCode}\nOutput:\n${tail(run.output, 6000)}\n\nAnswer in ${
              es ? 'Spanish' : 'English'
            }.`,
          },
        ],
        signal: new AbortController().signal,
        onDelta: (delta) => (summary += delta),
      });
      return summary.trim() || (es ? 'Los tests fallaron.' : 'The tests failed.');
    } catch {
      return es
        ? `Los tests fallaron con código ${run.exitCode}. Revisa la terminal para el detalle.`
        : `The tests failed with exit code ${run.exitCode}. Check the terminal for details.`;
    }
  }

  private async ensureTerminal(): Promise<vscode.Terminal> {
    if (this.terminal && this.terminal.exitStatus === undefined) {
      return this.terminal;
    }
    this.terminal = vscode.window.createTerminal({
      name: 'Kato Tests',
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    return this.terminal;
  }

  /** Shell integration activates a moment after the shell starts. */
  private async waitForShellIntegration(
    terminal: vscode.Terminal,
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return terminal.shellIntegration;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        disposable.dispose();
        resolve(undefined);
      }, SHELL_INTEGRATION_TIMEOUT_MS);
      const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === terminal) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(event.shellIntegration);
        }
      });
    });
  }

  /** Remembered command, else detected from the project, else asked once. */
  private async resolveCommand(root: vscode.Uri): Promise<string | undefined> {
    const remembered = this.memento.get<string>(COMMAND_KEY);
    if (remembered) {
      return remembered;
    }
    const detected = await detectTestCommand(root);
    if (detected) {
      await this.memento.update(COMMAND_KEY, detected);
      return detected;
    }
    const asked = await vscode.window.showInputBox({
      title: 'Kato: test command',
      prompt: "I couldn't tell how to run this project's tests. What's the command?",
      placeHolder: 'npm test / pytest / cargo test …',
      ignoreFocusOut: true,
    });
    if (asked?.trim()) {
      await this.memento.update(COMMAND_KEY, asked.trim());
      return asked.trim();
    }
    return undefined;
  }

  async forgetCommand(): Promise<void> {
    await this.memento.update(COMMAND_KEY, undefined);
  }
}

async function detectTestCommand(root: vscode.Uri): Promise<string | undefined> {
  const exists = async (name: string): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, name));
      return true;
    } catch {
      return false;
    }
  };
  if (await exists('package.json')) {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'package.json'));
      const pkg = JSON.parse(Buffer.from(raw).toString('utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) {
        return 'npm test';
      }
    } catch {
      // unreadable package.json — fall through to the other detectors
    }
  }
  if ((await exists('pytest.ini')) || (await exists('pyproject.toml')) || (await exists('tests'))) {
    return 'pytest';
  }
  if (await exists('Cargo.toml')) {
    return 'cargo test';
  }
  if (await exists('go.mod')) {
    return 'go test ./...';
  }
  return undefined;
}

function tail(text: string, chars: number): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}

/** Terminal output carries escape sequences that read terribly to an LLM. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '');
}
