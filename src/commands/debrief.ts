import * as vscode from 'vscode';
import type { AgentTaskRecord } from '../agent/agentManager';
import type { ChatMessage } from '../llm/llmProvider';
import type { GitHubService } from './github';
import { git } from './gitCli';

export type DebriefPeriod = 'today' | 'yesterday' | 'week';

/**
 * "¿Qué hice hoy?" — a spoken standup built from what actually happened:
 * your commits (across every repo in the workspace), the branches you
 * switched to, what is still uncommitted, the tasks the coding agent finished,
 * and your PRs when you are signed in to GitHub. The facts are gathered
 * deterministically; the LLM only turns them into a few sentences.
 */
export class Debrief {
  constructor(
    private readonly agentLog: () => AgentTaskRecord[],
    private readonly github: GitHubService,
  ) {}

  async build(period: DebriefPeriod, es: boolean): Promise<{ messages?: ChatMessage[]; lines: string[]; speech?: string }> {
    const { start, end } = range(period);
    const facts: string[] = [];
    const lines: string[] = [];

    for (const root of await gitRoots()) {
      const name = root.split('/').pop() ?? root;
      const email = (await git(root, ['config', 'user.email']).catch(() => '')).trim();
      const log = await git(root, [
        'log',
        '--all',
        '--no-merges',
        `--since=${start.toISOString()}`,
        `--until=${end.toISOString()}`,
        ...(email ? [`--author=${email}`] : []),
        '--name-only',
        '--date=format:%H:%M',
        '--format=COMMIT%x09%h%x09%ad%x09%s',
      ]).catch(() => '');
      const commits: Array<{ time: string; subject: string }> = [];
      const files = new Set<string>();
      for (const line of log.split('\n')) {
        if (line.startsWith('COMMIT\t')) {
          const [, , time, subject] = line.split('\t');
          commits.push({ time, subject });
        } else if (line.trim()) {
          files.add(line.trim());
        }
      }
      if (commits.length > 0) {
        facts.push(
          `Repo ${name}: ${commits.length} commit(s) by the user, touching ${files.size} file(s):\n` +
            commits.map((c) => `  - ${c.time} ${c.subject}`).join('\n'),
        );
        lines.push(`${name}: ${commits.length} commit${commits.length === 1 ? '' : 's'}`);
        for (const c of commits.slice(0, 8)) {
          lines.push(`  ${c.time} ${c.subject}`);
        }
      }
      const reflog = await git(root, ['reflog', `--since=${start.toISOString()}`, '--format=%gs']).catch(() => '');
      const branches = [
        ...new Set(
          reflog
            .split('\n')
            .map((l) => l.match(/^checkout: moving from .+ to (.+)$/)?.[1])
            .filter((b): b is string => Boolean(b) && !/^[0-9a-f]{7,40}$/.test(b as string)),
        ),
      ];
      if (branches.length > 0) {
        facts.push(`Repo ${name}: branches worked on: ${branches.join(', ')}`);
      }
      if (period === 'today') {
        const status = (await git(root, ['status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean);
        if (status.length > 0) {
          const names = status.slice(0, 6).map((l) => l.slice(3).split('/').pop());
          facts.push(`Repo ${name}: ${status.length} uncommitted file(s) right now: ${names.join(', ')}`);
          lines.push(`${name}: ${status.length} sin commitear`);
        }
      }
    }

    const tasks = this.agentLog().filter((t) => {
      const at = new Date(t.at);
      return at >= start && at < end;
    });
    if (tasks.length > 0) {
      facts.push(
        `Tasks completed with the coding agent (${tasks.length}):\n` +
          tasks
            .map((t) => `  - ${t.ok ? 'done' : 'FAILED'} in ${Math.round(t.seconds / 60)} min: "${t.task.slice(0, 160)}" → ${t.summary.slice(0, 200)}`)
            .join('\n'),
      );
      lines.push(`${es ? 'Agente' : 'Agent'}: ${tasks.length} ${es ? 'tarea' : 'task'}${tasks.length === 1 ? '' : 's'}`);
    }

    const prs = await this.github.activitySince(start);
    if (prs.length > 0) {
      facts.push(`GitHub pull requests by the user updated in the period:\n${prs.map((p) => `  - ${p}`).join('\n')}`);
      lines.push(...prs.slice(0, 5));
    }

    if (facts.length === 0) {
      const when = es ? { today: 'hoy', yesterday: 'ayer', week: 'esta semana' }[period] : { today: 'today', yesterday: 'yesterday', week: 'this week' }[period];
      return {
        lines,
        speech: es
          ? `No encuentro actividad tuya ${when}: ni commits, ni tareas del agente, ni PRs.`
          : `I can't find any activity of yours ${when}: no commits, agent tasks or PRs.`,
      };
    }
    const label = { today: 'today', yesterday: 'yesterday', week: 'the last 7 days' }[period];
    return {
      lines,
      messages: [
        {
          role: 'system',
          content:
            `You are Kato, a voice assistant. Give the user a spoken standup of what they did ${label}, from the facts below. ` +
            '3 to 5 short sentences: what got done (grouped by theme, not commit by commit), what is in progress or uncommitted, ' +
            'and — only if it is evident — a natural next step. Speak to the user in second person. No markdown, no lists, ' +
            `no hashes, no times unless they matter. Reply in ${es ? 'Spanish' : 'English'}.`,
        },
        { role: 'user', content: facts.join('\n\n') },
      ],
    };
  }
}

function range(period: DebriefPeriod): { start: Date; end: Date } {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  if (period === 'yesterday') {
    return { start: new Date(midnight.getTime() - day), end: midnight };
  }
  if (period === 'week') {
    return { start: new Date(midnight.getTime() - 6 * day), end: new Date(Date.now() + 60_000) };
  }
  return { start: midnight, end: new Date(Date.now() + 60_000) };
}

/** Every git repository behind the workspace folders, deduplicated. */
async function gitRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const top = (await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
    if (top) {
      roots.add(top);
    }
  }
  return [...roots];
}
