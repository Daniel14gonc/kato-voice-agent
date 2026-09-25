import { spawn } from 'node:child_process';
import type { AgentExploreRequest, AgentProvider } from '../agentProvider';
import { CLAUDE_MISSING, resolveClaudeCli } from '../cliPaths';
import { describeTool, toolDetail } from './claudeCodeSession';

/**
 * Claude Code adapter over the `claude` CLI in headless mode (`-p`). In
 * non-interactive mode, tools that need permission (Edit/Write/Bash) are
 * auto-denied, so exploration is effectively read-only — exactly what deep
 * understanding needs. Auth reuses the user's existing `claude` login; no API
 * key flows through Kato. stream-json output gives us per-tool progress.
 */
export class ClaudeCodeAgent implements AgentProvider {
  readonly name = 'claude-code';

  constructor(private readonly getCliPath: () => string) {}

  private resolveCli(): string {
    // Fall back to PATH resolution if no known location exists.
    return resolveClaudeCli(this.getCliPath()) ?? 'claude';
  }

  runReadOnly(request: AgentExploreRequest): Promise<string> {
    const cli = this.resolveCli();
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(request.model ? ['--model', request.model] : []),
      // Grant access to the other roots of a multi-root workspace.
      ...(request.extraDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
    ];
    return new Promise<string>((resolve, reject) => {
      const child = spawn(cli, args, { cwd: request.cwd, env: process.env });
      let result: string | undefined;
      let stderr = '';
      let lineBuffer = '';

      const onAbort = () => child.kill('SIGTERM');
      request.signal.addEventListener('abort', onAbort, { once: true });

      child.stdin.write(request.prompt);
      child.stdin.end();

      child.stdout.on('data', (data: Buffer) => {
        lineBuffer += data.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          this.handleEvent(line, request, (r) => (result = r));
        }
      });
      child.stderr.on('data', (data: Buffer) => (stderr += data.toString('utf8')));

      child.on('error', (err: NodeJS.ErrnoException) => {
        request.signal.removeEventListener('abort', onAbort);
        reject(
          err.code === 'ENOENT'
            ? new Error(CLAUDE_MISSING)
            : err,
        );
      });
      child.on('close', (code) => {
        request.signal.removeEventListener('abort', onAbort);
        if (request.signal.aborted) {
          reject(new Error('aborted'));
        } else if (result !== undefined) {
          resolve(result);
        } else {
          reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
        }
      });
    });
  }

  private handleEvent(
    line: string,
    request: AgentExploreRequest,
    setResult: (r: string) => void,
  ): void {
    if (!line.trim()) {
      return;
    }
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const target = input.file_path ?? input.pattern ?? input.query ?? input.command ?? '';
          request.onProgress?.(`${block.name} ${String(target).slice(0, 80)}`.trim());
          request.onActivity?.({
            id: String(block.id ?? Math.random()),
            name: String(block.name),
            label: describeTool(String(block.name), input),
            detail: toolDetail(input),
          });
        }
      }
    } else if (event.type === 'result') {
      if (event.subtype === 'success' && typeof event.result === 'string') {
        setResult(event.result);
      }
    }
  }
}
