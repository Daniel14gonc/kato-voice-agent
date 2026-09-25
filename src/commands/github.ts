import * as vscode from 'vscode';
import { getConfig } from '../config';
import type { Referent } from '../conversation/referents';
import type { LlmProvider } from '../llm/llmProvider';
import type { VoiceOutcome } from './branches';
import { toBranchName } from './branches';
import { currentBranch, defaultBranch, git, githubSlug, isDirty, repoRoot } from './gitCli';

const API = 'https://api.github.com';
const LOG_TAIL_LINES = 120;
const MAX_COMMENTS = 25;

interface RepoContext {
  cwd: string;
  owner: string;
  repo: string;
  branch: string;
}

interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  user: { login: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  requested_reviewers?: Array<{ login: string }>;
}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  app?: { slug?: string };
  output?: { title?: string | null; summary?: string | null };
}

export interface GitHubOutcome extends VoiceOutcome {
  /** Items to walk by voice ("la siguiente") — review comments by file and line. */
  referents?: Array<Omit<Referent, 'id'>>;
  /** A task for the coding agent, built from GitHub data (CI logs, review comments, an issue). */
  delegate?: string;
}

/**
 * GitHub by voice, through the GitHub sign-in VS Code already has — no `gh`
 * install, no token to paste. Reading (CI, reviews, PRs, issues) answers
 * directly; fixing always goes to the coding agent with the GitHub data
 * attached; anything that publishes (push, open a PR) asks first.
 */
export class GitHubService {
  constructor(
    private readonly llm: LlmProvider,
    private readonly log: (message: string) => void,
  ) {}

  // ---------- plumbing ----------

  private async token(interactive: boolean): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], interactive ? { createIfNone: true } : { silent: true });
      return session?.accessToken;
    } catch (err) {
      this.log(`[github] auth failed: ${String(err)}`);
      return undefined;
    }
  }

  private async api<T>(path: string, init: RequestInit = {}, interactive = true): Promise<T> {
    const token = await this.token(interactive);
    if (!token) {
      throw new Error('NO_AUTH');
    }
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`GitHub ${response.status}: ${detail.slice(0, 160)}`);
    }
    const type = response.headers.get('content-type') ?? '';
    return (type.includes('json') ? await response.json() : await response.text()) as T;
  }

  private async context(): Promise<RepoContext | string> {
    const cwd = await repoRoot();
    if (!cwd) {
      return 'NO_REPO';
    }
    const slug = await githubSlug(cwd);
    if (!slug) {
      return 'NO_GITHUB';
    }
    return { cwd, ...slug, branch: await currentBranch(cwd) };
  }

  /** Every entry point funnels its failures through here, so they all sound the same. */
  private async run(es: boolean, body: (ctx: RepoContext) => Promise<GitHubOutcome>): Promise<GitHubOutcome> {
    const ctx = await this.context();
    if (typeof ctx === 'string' && ctx === 'NO_REPO') {
      return { speech: es ? 'Este proyecto no es un repositorio git.' : "This project isn't a git repository." };
    }
    if (typeof ctx === 'string') {
      return {
        speech: es
          ? 'Este repositorio no tiene un remoto de GitHub llamado origin.'
          : "This repository has no GitHub remote called origin.",
      };
    }
    try {
      return await body(ctx);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      if (message === 'NO_AUTH') {
        return {
          speech: es
            ? 'Necesito que inicies sesión en GitHub desde VS Code; acepta el diálogo y vuelve a pedírmelo.'
            : 'I need you to sign in to GitHub in VS Code; accept the dialog and ask me again.',
        };
      }
      this.log(`[github] ${message}`);
      return { speech: es ? `GitHub falló: ${message.slice(0, 140)}` : `GitHub failed: ${message.slice(0, 140)}` };
    }
  }

  private async summarize(system: string, content: string, es: boolean, signal?: AbortSignal): Promise<string> {
    let text = '';
    await this.llm.streamChat({
      model: getConfig().routerModel,
      messages: [
        {
          role: 'system',
          content: `${system} Answer in ${es ? 'Spanish' : 'English'}. It is read aloud by TTS: no markdown, no lists, no URLs, no file paths — say file names without extension.`,
        },
        { role: 'user', content },
      ],
      signal: signal ?? AbortSignal.timeout(30_000),
      onDelta: (delta) => (text += delta),
    });
    return text.trim();
  }

  private async prForBranch(ctx: RepoContext): Promise<PullRequest | undefined> {
    const prs = await this.api<PullRequest[]>(
      `/repos/${ctx.owner}/${ctx.repo}/pulls?state=open&head=${encodeURIComponent(`${ctx.owner}:${ctx.branch}`)}`,
    );
    return prs[0];
  }

  private async checkRuns(ctx: RepoContext, ref: string): Promise<CheckRun[]> {
    const result = await this.api<{ check_runs: CheckRun[] }>(
      `/repos/${ctx.owner}/${ctx.repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    );
    // Re-runs leave older runs with the same name behind; the newest one counts.
    const latest = new Map<string, CheckRun>();
    for (const run of result.check_runs) {
      const seen = latest.get(run.name);
      if (!seen || run.id > seen.id) {
        latest.set(run.name, run);
      }
    }
    return [...latest.values()];
  }

  // ---------- CI ----------

  /** "¿Pasó el CI?" — green, red (which ones) or still running. */
  ciStatus(es: boolean): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      const pr = await this.prForBranch(ctx).catch(() => undefined);
      const runs = await this.checkRuns(ctx, pr?.head.sha ?? ctx.branch);
      return { speech: describeChecks(runs, ctx.branch, es) };
    });
  }

  /** "Arregla el CI": the failing checks' output and log tails, handed to the agent. */
  fixCi(userWords: string, es: boolean): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      const pr = await this.prForBranch(ctx).catch(() => undefined);
      const failing = (await this.checkRuns(ctx, pr?.head.sha ?? ctx.branch)).filter((r) => isFailure(r.conclusion));
      if (failing.length === 0) {
        return { speech: es ? `No hay checks fallando en ${ctx.branch}.` : `No checks are failing on ${ctx.branch}.` };
      }
      const sections: string[] = [];
      for (const run of failing.slice(0, 4)) {
        const lines = [`## Failing check: ${run.name} (${run.conclusion})`];
        if (run.output?.title) {
          lines.push(`Title: ${run.output.title}`);
        }
        if (run.output?.summary) {
          lines.push(`Summary: ${run.output.summary.slice(0, 1500)}`);
        }
        const annotations = await this.api<Array<{ path: string; start_line: number; message: string; annotation_level: string }>>(
          `/repos/${ctx.owner}/${ctx.repo}/check-runs/${run.id}/annotations?per_page=30`,
        ).catch(() => []);
        for (const a of annotations.slice(0, 20)) {
          lines.push(`- ${a.annotation_level} ${a.path}:${a.start_line} ${a.message.replace(/\s+/g, ' ').slice(0, 300)}`);
        }
        if (run.app?.slug === 'github-actions') {
          // Check run ids are Actions job ids; the log is plain text.
          const log = await this.api<string>(`/repos/${ctx.owner}/${ctx.repo}/actions/jobs/${run.id}/logs`).catch(() => '');
          if (log) {
            const tail = String(log).split('\n').slice(-LOG_TAIL_LINES).map((l) => l.replace(/^\S+Z\s/, ''));
            lines.push(`Last ${LOG_TAIL_LINES} log lines:\n${tail.join('\n')}`);
          }
        }
        sections.push(lines.join('\n'));
      }
      const names = failing.map((r) => r.name).slice(0, 3).join(', ');
      return {
        // The agent manager adds "se lo paso a Claude Code…"; this only says what failed.
        speech: es ? `En el CI falla ${names}.` : `${names} failing in CI.`,
        delegate:
          `${userWords}\n\nThe GitHub CI is failing on branch ${ctx.branch}. Reproduce locally if you can, fix the root cause, ` +
          `and verify with the same command CI runs. Details:\n\n${sections.join('\n\n')}`,
      };
    });
  }

  // ---------- pull requests ----------

  /** "¿Cómo va mi PR?" — review state, comment count and CI in one answer. */
  prStatus(es: boolean): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      const pr = await this.prForBranch(ctx);
      if (!pr) {
        return {
          speech: es
            ? `${ctx.branch} no tiene un PR abierto. Di "abre un PR" si quieres crearlo.`
            : `${ctx.branch} has no open PR. Say "open a PR" to create one.`,
        };
      }
      const [reviews, comments, runs] = await Promise.all([
        this.api<Array<{ state: string; user: { login: string } }>>(`/repos/${ctx.owner}/${ctx.repo}/pulls/${pr.number}/reviews`),
        this.api<unknown[]>(`/repos/${ctx.owner}/${ctx.repo}/pulls/${pr.number}/comments?per_page=100`),
        this.checkRuns(ctx, pr.head.sha).catch(() => [] as CheckRun[]),
      ]);
      const byUser = new Map<string, string>();
      for (const review of reviews) {
        if (review.state !== 'COMMENTED') {
          byUser.set(review.user.login, review.state);
        }
      }
      const approved = [...byUser.entries()].filter(([, s]) => s === 'APPROVED').map(([u]) => u);
      const changes = [...byUser.entries()].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([u]) => u);
      const review = changes.length
        ? es
          ? `${changes.join(' y ')} pidió cambios`
          : `${changes.join(' and ')} requested changes`
        : approved.length
          ? es
            ? `aprobado por ${approved.join(' y ')}`
            : `approved by ${approved.join(' and ')}`
          : es
            ? 'sin reviews todavía'
            : 'no reviews yet';
      const commentPart = comments.length
        ? es
          ? `, ${comments.length} comentario${comments.length === 1 ? '' : 's'} en el código`
          : `, ${comments.length} code comment${comments.length === 1 ? '' : 's'}`
        : '';
      return {
        speech:
          (es ? `El PR ${pr.number}, «${pr.title}»: ${review}${commentPart}. ` : `PR ${pr.number}, “${pr.title}”: ${review}${commentPart}. `) +
          describeChecks(runs, ctx.branch, es),
      };
    });
  }

  /** "Léeme los comentarios del review" — summarized, and walkable by file with "la siguiente". */
  reviewComments(es: boolean, signal?: AbortSignal): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      const data = await this.collectReview(ctx);
      if (!data) {
        return { speech: es ? `${ctx.branch} no tiene un PR abierto.` : `${ctx.branch} has no open PR.` };
      }
      if (data.items.length === 0) {
        return { speech: es ? `El PR ${data.pr.number} no tiene comentarios.` : `PR ${data.pr.number} has no comments.` };
      }
      const speech = await this.summarize(
        'Summarize these pull request review comments for the author, in 2-4 short spoken sentences: who asked for what, ' +
          'grouped by theme, most important first. End by offering to have the agent address them.',
        data.items.map((c) => `${c.who}${c.where ? ` on ${c.where}` : ''}: ${c.body}`).join('\n\n'),
        es,
        signal,
      );
      return { speech, referents: data.referents };
    });
  }

  /** "Arregla los comentarios del review": the comments, with file and line, as the agent's task. */
  fixReview(userWords: string, es: boolean): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      const data = await this.collectReview(ctx);
      if (!data || data.items.length === 0) {
        return { speech: es ? 'No encontré comentarios de review que atender.' : "I found no review comments to address." };
      }
      return {
        speech: es
          ? `Son ${data.items.length} comentarios en el PR ${data.pr.number}.`
          : `${data.items.length} comments on PR ${data.pr.number}.`,
        delegate:
          `${userWords}\n\nAddress the review comments on PR #${data.pr.number} ("${data.pr.title}"). For each one, make the ` +
          'change the reviewer asked for, or explain in your summary why not. Do not push.\n\n' +
          data.items.map((c) => `- ${c.who}${c.where ? ` (${c.where})` : ''}: ${c.body}`).join('\n'),
      };
    });
  }

  private async collectReview(ctx: RepoContext): Promise<
    | {
        pr: PullRequest;
        items: Array<{ who: string; where?: string; body: string }>;
        referents: Array<Omit<Referent, 'id'>>;
      }
    | undefined
  > {
    const pr = await this.prForBranch(ctx);
    if (!pr) {
      return undefined;
    }
    const [inline, reviews] = await Promise.all([
      this.api<Array<{ user: { login: string }; path: string; line: number | null; original_line: number | null; body: string; in_reply_to_id?: number }>>(
        `/repos/${ctx.owner}/${ctx.repo}/pulls/${pr.number}/comments?per_page=100`,
      ),
      this.api<Array<{ user: { login: string }; body: string; state: string }>>(`/repos/${ctx.owner}/${ctx.repo}/pulls/${pr.number}/reviews`),
    ]);
    const items: Array<{ who: string; where?: string; body: string }> = [];
    const referents: Array<Omit<Referent, 'id'>> = [];
    for (const review of reviews) {
      if (review.body?.trim()) {
        items.push({ who: review.user.login, body: review.body.trim().slice(0, 800) });
      }
    }
    for (const comment of inline.filter((c) => !c.in_reply_to_id).slice(-MAX_COMMENTS)) {
      const line = comment.line ?? comment.original_line ?? 1;
      items.push({ who: comment.user.login, where: `${comment.path}:${line}`, body: comment.body.trim().slice(0, 800) });
      const uri = vscode.Uri.joinPath(vscode.Uri.file(ctx.cwd), comment.path);
      referents.push({
        label: `${comment.path}:${line} — ${comment.user.login}: ${comment.body.replace(/\s+/g, ' ').slice(0, 80)}`,
        uri,
        range: new vscode.Range(line - 1, 0, line - 1, 0),
        spoken: `${comment.user.login}: ${comment.body.replace(/\s+/g, ' ').replace(/[`*_>#]/g, '').slice(0, 120)}`,
      });
    }
    return { pr, items, referents };
  }

  /** "¿Qué PRs hay?" — yours and the ones waiting for your review, first. */
  listPrs(es: boolean): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      const [prs, me] = await Promise.all([
        this.api<PullRequest[]>(`/repos/${ctx.owner}/${ctx.repo}/pulls?state=open&per_page=50`),
        this.api<{ login: string }>('/user'),
      ]);
      if (prs.length === 0) {
        return { speech: es ? 'No hay PRs abiertos.' : 'There are no open PRs.' };
      }
      const mine = prs.filter((pr) => pr.user.login === me.login);
      const forMe = prs.filter((pr) => pr.requested_reviewers?.some((r) => r.login === me.login));
      const say = (pr: PullRequest) => (es ? `el ${pr.number} de ${pr.user.login}, «${pr.title}»` : `${pr.number} by ${pr.user.login}, “${pr.title}”`);
      const parts = [es ? `Hay ${prs.length} PR${prs.length === 1 ? '' : 's'} abierto${prs.length === 1 ? '' : 's'}.` : `${prs.length} open PR${prs.length === 1 ? '' : 's'}.`];
      if (forMe.length) {
        parts.push((es ? 'Esperan tu review: ' : 'Waiting for your review: ') + forMe.slice(0, 3).map(say).join('; ') + '.');
      }
      if (mine.length) {
        parts.push((es ? 'Tuyos: ' : 'Yours: ') + mine.slice(0, 3).map((pr) => `${pr.number}, «${pr.title}»`).join('; ') + '.');
      }
      if (!forMe.length && !mine.length) {
        parts.push((es ? 'Los más recientes: ' : 'Most recent: ') + prs.slice(0, 3).map(say).join('; ') + '.');
      }
      parts.push(es ? 'Di "ponme en el PR" con su número o su autor para revisarlo.' : 'Say "check out PR" with its number or author to look at it.');
      return { speech: parts.join(' ') };
    });
  }

  /** "Ponme en el PR de Ana" / "checkout PR 42". */
  checkoutPr(number: number | undefined, who: string | undefined, es: boolean): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      const prs = await this.api<PullRequest[]>(`/repos/${ctx.owner}/${ctx.repo}/pulls?state=open&per_page=50`);
      const wanted = who?.toLowerCase().replace(/\s+/g, '');
      const pr =
        (number ? prs.find((p) => p.number === number) : undefined) ??
        (wanted
          ? prs.find((p) => p.user.login.toLowerCase().includes(wanted)) ??
            prs.find((p) => p.title.toLowerCase().replace(/\s+/g, '').includes(wanted))
          : undefined);
      if (!pr) {
        return { speech: es ? 'No encontré ese PR entre los abiertos.' : "I couldn't find that PR among the open ones." };
      }
      if (await isDirty(ctx.cwd)) {
        return {
          speech: es
            ? `Tienes cambios sin commitear. Di "guarda mis cambios" y luego te pongo en el PR ${pr.number}.`
            : `You have uncommitted changes. Say "stash my changes" and then I'll check out PR ${pr.number}.`,
        };
      }
      const sameRepo = pr.head.repo?.full_name === `${ctx.owner}/${ctx.repo}`;
      const local = sameRepo ? pr.head.ref : `pr-${pr.number}-${toBranchName(pr.head.ref)}`;
      if (sameRepo) {
        await git(ctx.cwd, ['fetch', '--quiet', 'origin', pr.head.ref], 60_000);
        await git(ctx.cwd, ['switch', pr.head.ref]).catch(() =>
          git(ctx.cwd, ['switch', '-c', pr.head.ref, '--track', `origin/${pr.head.ref}`]),
        );
      } else {
        await git(ctx.cwd, ['fetch', '--quiet', 'origin', `pull/${pr.number}/head:${local}`], 60_000);
        await git(ctx.cwd, ['switch', local]);
      }
      return {
        speech: es
          ? `Listo, estás en el PR ${pr.number} de ${pr.user.login}, «${pr.title}». Puedes pedirme un tour de los cambios.`
          : `Done — you're on PR ${pr.number} by ${pr.user.login}, “${pr.title}”. Ask me for a tour of the changes.`,
      };
    });
  }

  /** "Abre un PR con esto" — push + create, only after a spoken yes. */
  openPr(es: boolean, signal?: AbortSignal): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      const base = await defaultBranch(ctx.cwd);
      if (ctx.branch === base) {
        return {
          speech: es
            ? `Estás en ${base}. Crea una rama primero, por ejemplo "crea la rama fix login".`
            : `You're on ${base}. Create a branch first, e.g. "create branch fix login".`,
        };
      }
      const existing = await this.prForBranch(ctx);
      if (existing) {
        return { speech: es ? `${ctx.branch} ya tiene el PR ${existing.number} abierto.` : `${ctx.branch} already has PR ${existing.number} open.` };
      }
      const log = (await git(ctx.cwd, ['log', '--format=%s%n%b', `origin/${base}..HEAD`]).catch(() => '')).trim();
      if (!log) {
        return { speech: es ? `No hay commits nuevos respecto a ${base}.` : `There are no new commits compared to ${base}.` };
      }
      const stat = (await git(ctx.cwd, ['diff', '--stat', `origin/${base}...HEAD`]).catch(() => '')).slice(0, 3000);
      let raw = '';
      await this.llm.streamChat({
        model: getConfig().routerModel,
        messages: [
          {
            role: 'system',
            content:
              'Write a GitHub pull request from these commits. Reply with ONLY JSON: {"title": "<imperative, max 70 chars>", ' +
              '"body": "<markdown: a Summary section with 2-5 bullets, and a Testing section>"} in English.',
          },
          { role: 'user', content: `Commits:\n${log.slice(0, 6000)}\n\nFiles:\n${stat}` },
        ],
        signal: signal ?? AbortSignal.timeout(30_000),
        onDelta: (delta) => (raw += delta),
      });
      let title = log.split('\n')[0].slice(0, 70);
      let body = '';
      try {
        const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        title = String(parsed.title || title).slice(0, 100);
        body = String(parsed.body || '');
      } catch {
        // keep the first commit subject as the title
      }
      return {
        speech: es
          ? `Voy a subir ${ctx.branch} y abrir un PR hacia ${base} titulado «${title}». ¿Lo hago?`
          : `I'll push ${ctx.branch} and open a PR into ${base} titled “${title}”. Go ahead?`,
        confirm: {
          description: `push branch ${ctx.branch} and open a GitHub PR into ${base} titled "${title}"`,
          run: async () => {
            await git(ctx.cwd, ['push', '--set-upstream', 'origin', ctx.branch], 120_000);
            const pr = await this.api<PullRequest>(`/repos/${ctx.owner}/${ctx.repo}/pulls`, {
              method: 'POST',
              body: JSON.stringify({ title, body, head: ctx.branch, base }),
            });
            void vscode.env.openExternal(vscode.Uri.parse(pr.html_url));
            return es ? `Listo, abrí el PR ${pr.number}. Te lo dejé en el navegador.` : `Done — opened PR ${pr.number}. It's in your browser.`;
          },
        },
      };
    });
  }

  // ---------- issues ----------

  /** "¿De qué trata el issue 42?" */
  issue(number: number | undefined, es: boolean, signal?: AbortSignal): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      if (!number) {
        return { speech: es ? '¿Qué número de issue?' : 'Which issue number?' };
      }
      const issue = await this.fetchIssue(ctx, number);
      const speech = await this.summarize(
        'Explain this GitHub issue to a developer in 2-3 short spoken sentences: the problem or request, and anything notable ' +
          'from the discussion. End by offering to start working on it.',
        issue.text,
        es,
        signal,
      );
      return { speech };
    });
  }

  /** "Trabaja en el issue 42": a branch for it, then the issue as the agent's task. */
  workOnIssue(number: number | undefined, userWords: string, es: boolean): Promise<GitHubOutcome> {
    return this.run(es, async (ctx) => {
      if (!number) {
        return { speech: es ? '¿En qué número de issue trabajo?' : 'Which issue number should I work on?' };
      }
      const issue = await this.fetchIssue(ctx, number);
      const branch = `issue-${number}-${toBranchName(issue.title).replace(/\//g, '-').slice(0, 40).replace(/-+$/, '')}`;
      let branchNote = '';
      try {
        await git(ctx.cwd, ['switch', '-c', branch]);
        branchNote = es ? ` Creé la rama ${branch}.` : ` Created branch ${branch}.`;
      } catch (err) {
        this.log(`[github] could not create ${branch}: ${String(err)}`);
      }
      return {
        speech: es ? `Issue ${number}, «${issue.title}».${branchNote}` : `Issue ${number}, “${issue.title}”.${branchNote}`,
        delegate: `${userWords}\n\nImplement GitHub issue #${number}. Do not push or open a PR.\n\n${issue.text}`,
      };
    });
  }

  private async fetchIssue(ctx: RepoContext, number: number): Promise<{ title: string; text: string }> {
    const [issue, comments] = await Promise.all([
      this.api<{ title: string; body: string | null; user: { login: string }; labels: Array<{ name: string }> }>(
        `/repos/${ctx.owner}/${ctx.repo}/issues/${number}`,
      ),
      this.api<Array<{ user: { login: string }; body: string }>>(`/repos/${ctx.owner}/${ctx.repo}/issues/${number}/comments?per_page=20`),
    ]);
    const text =
      `#${number} ${issue.title} (by ${issue.user.login}${issue.labels.length ? `; labels: ${issue.labels.map((l) => l.name).join(', ')}` : ''})\n\n` +
      `${(issue.body ?? '').slice(0, 4000)}\n\n` +
      comments.map((c) => `${c.user.login}: ${c.body.slice(0, 600)}`).join('\n\n');
    return { title: issue.title, text };
  }

  // ---------- for the daily debrief ----------

  /** PRs you opened, merged or reviewed since `since`; empty when not signed in (never prompts). */
  async activitySince(since: Date): Promise<string[]> {
    const cwd = await repoRoot();
    const slug = cwd ? await githubSlug(cwd) : undefined;
    if (!slug || !(await this.token(false))) {
      return [];
    }
    try {
      const day = since.toISOString().slice(0, 10);
      const result = await this.api<{ items: Array<{ number: number; title: string; state: string; pull_request?: { merged_at?: string | null } }> }>(
        `/search/issues?q=${encodeURIComponent(`repo:${slug.owner}/${slug.repo} is:pr author:@me updated:>=${day}`)}&per_page=20`,
        {},
        false,
      );
      return result.items.map(
        (item) => `PR #${item.number} "${item.title}" — ${item.pull_request?.merged_at ? 'merged' : item.state}`,
      );
    } catch {
      return [];
    }
  }
}

function isFailure(conclusion: string | null): boolean {
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure' || conclusion === 'action_required';
}

function describeChecks(runs: CheckRun[], branch: string, es: boolean): string {
  if (runs.length === 0) {
    return es ? `No hay checks de CI para ${branch}.` : `There are no CI checks for ${branch}.`;
  }
  const failed = runs.filter((r) => isFailure(r.conclusion));
  const running = runs.filter((r) => r.status !== 'completed');
  if (failed.length > 0) {
    const names = failed.slice(0, 3).map((r) => r.name).join(', ');
    return es
      ? `El CI falló: ${failed.length} de ${runs.length} checks en rojo, ${names}. Di "arregla el CI" y se lo paso al agente con los logs.`
      : `CI failed: ${failed.length} of ${runs.length} checks red, ${names}. Say "fix the CI" and I'll hand the logs to the agent.`;
  }
  if (running.length > 0) {
    return es
      ? `El CI sigue corriendo: ${runs.length - running.length} de ${runs.length} checks terminaron, sin fallos hasta ahora.`
      : `CI is still running: ${runs.length - running.length} of ${runs.length} checks done, no failures so far.`;
  }
  return es ? `Todo verde: pasaron los ${runs.length} checks.` : `All green: all ${runs.length} checks passed.`;
}
