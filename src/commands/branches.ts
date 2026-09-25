import {
  conflictedFiles,
  currentBranch,
  defaultBranch,
  git,
  GitError,
  isDirty,
  isOverwriteError,
  listBranches,
  matchBranch,
  repoRoot,
} from './gitCli';

/** A spoken reply, optionally with an action that waits for the user's "sí". */
export interface VoiceOutcome {
  speech: string;
  confirm?: { description: string; run: () => Promise<string> };
}

const NOT_A_REPO = (es: boolean): VoiceOutcome => ({
  speech: es ? 'Este proyecto no es un repositorio git.' : "This project isn't a git repository.",
});

/**
 * Branch work by voice. Everything that could lose or tangle work (stashing,
 * creating a branch nobody asked for by that exact name, merging) asks first;
 * everything else just happens and is said in one sentence.
 */
export class BranchService {
  constructor(
    private readonly log: (message: string) => void,
    /** Hands a task to the coding agent; returns the spoken acknowledgment. */
    private readonly delegate: (instruction: string, es: boolean) => string,
  ) {}

  async switchTo(spokenName: string, create: boolean, es: boolean): Promise<VoiceOutcome> {
    const cwd = await repoRoot();
    if (!cwd) {
      return NOT_A_REPO(es);
    }
    if (create) {
      return this.create(cwd, spokenName, es);
    }
    const branches = await listBranches(cwd);
    const match = matchBranch(spokenName, branches);
    if (!match) {
      // It used to create a branch silently here — with speech recognition,
      // that meant junk branches named after mishearings.
      const name = toBranchName(spokenName);
      return {
        speech: es
          ? `No encontré ninguna rama que se parezca a ${spokenName}. ¿Creo una nueva llamada ${name}?`
          : `I couldn't find a branch like ${spokenName}. Should I create a new one called ${name}?`,
        confirm: {
          description: `create and switch to a new git branch "${name}"`,
          run: async () => (await this.create(cwd, name, es)).speech,
        },
      };
    }
    const current = await currentBranch(cwd);
    if (current === match.name) {
      return { speech: es ? `Ya estás en ${match.name}.` : `You're already on ${match.name}.` };
    }
    const dirty = await isDirty(cwd);
    try {
      await git(cwd, ['switch', match.name]);
    } catch (err) {
      if (!isOverwriteError(err)) {
        return { speech: failed(es, err) };
      }
      return {
        speech: es
          ? `Tus cambios sin commitear chocan con ${match.name}. ¿Los guardo aparte y me cambio? Después di "recupera mis cambios".`
          : `Your uncommitted changes clash with ${match.name}. Should I set them aside and switch? Then say "bring my changes back".`,
        confirm: {
          description: `stash the uncommitted changes and switch to branch "${match.name}"`,
          run: async () => {
            await git(cwd, ['stash', 'push', '--include-untracked', '-m', `kato: before switching to ${match.name}`]);
            await git(cwd, ['switch', match.name]);
            return es
              ? `Listo: guardé tus cambios y estás en ${match.name}. Cuando quieras, di "recupera mis cambios".`
              : `Done: your changes are set aside and you're on ${match.name}. Say "bring my changes back" when you want them.`;
          },
        },
      };
    }
    const carried = dirty ? (es ? ' Tus cambios sin commitear vinieron contigo.' : ' Your uncommitted changes came along.') : '';
    const note = match.exact ? '' : es ? ` (entendí ${match.name})` : ` (I took that as ${match.name})`;
    return { speech: es ? `Listo, estás en ${match.name}${note}.${carried}` : `Done, you're on ${match.name}${note}.${carried}` };
  }

  private async create(cwd: string, spokenName: string, es: boolean): Promise<VoiceOutcome> {
    const name = toBranchName(spokenName);
    try {
      await git(cwd, ['switch', '-c', name]);
      return { speech: es ? `Listo, creé la rama ${name} y estás en ella.` : `Done — created ${name} and switched to it.` };
    } catch (err) {
      if (/already exists/i.test(String(err))) {
        await git(cwd, ['switch', name]);
        return { speech: es ? `${name} ya existía; te cambié a ella.` : `${name} already existed; switched to it.` };
      }
      return { speech: failed(es, err) };
    }
  }

  /** "¿Qué tiene mi rama que no tenga main?" — both directions, in one breath. */
  async compareWithMain(es: boolean): Promise<VoiceOutcome> {
    const cwd = await repoRoot();
    if (!cwd) {
      return NOT_A_REPO(es);
    }
    const base = await defaultBranch(cwd);
    const current = await currentBranch(cwd);
    if (current === base) {
      return { speech: es ? `Estás en ${base}; no hay nada que comparar.` : `You're on ${base}; nothing to compare.` };
    }
    const ref = await this.baseRef(cwd, base);
    const [behind, ahead] = (await git(cwd, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]))
      .trim()
      .split(/\s+/)
      .map(Number);
    const subjects = (await git(cwd, ['log', '--format=%s', '-n', '3', `${ref}..HEAD`])).trim().split('\n').filter(Boolean);
    const stat = (await git(cwd, ['diff', '--shortstat', `${ref}...HEAD`])).trim();
    const files = Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0);
    const parts: string[] = [];
    if (ahead === 0) {
      parts.push(es ? `${current} no tiene commits que ${base} no tenga.` : `${current} has no commits that ${base} lacks.`);
    } else {
      const list = subjects.map((s) => `«${s}»`).join(', ');
      parts.push(
        es
          ? `${current} tiene ${ahead} commit${ahead === 1 ? '' : 's'} que ${base} no, tocando ${files} archivo${files === 1 ? '' : 's'}${list ? `: ${list}${ahead > 3 ? ' y más' : ''}` : ''}.`
          : `${current} has ${ahead} commit${ahead === 1 ? '' : 's'} ${base} doesn't, touching ${files} file${files === 1 ? '' : 's'}${list ? `: ${list}${ahead > 3 ? ' and more' : ''}` : ''}.`,
      );
    }
    if (behind > 0) {
      parts.push(
        es
          ? `Y ${base} tiene ${behind} commit${behind === 1 ? '' : 's'} nuevo${behind === 1 ? '' : 's'} que tú no; di "trae lo último de ${base}" para traerlos.`
          : `And ${base} has ${behind} new commit${behind === 1 ? '' : 's'} you don't; say "pull in the latest ${base}" to bring them in.`,
      );
    } else {
      parts.push(es ? `Estás al día con ${base}.` : `You're up to date with ${base}.`);
    }
    return { speech: parts.join(' ') };
  }

  /** "Trae lo último de main": fetch + merge; conflicts go to the agent, if the user agrees. */
  async updateFromMain(es: boolean): Promise<VoiceOutcome> {
    const cwd = await repoRoot();
    if (!cwd) {
      return NOT_A_REPO(es);
    }
    const base = await defaultBranch(cwd);
    const ref = await this.baseRef(cwd, base);
    const behind = Number((await git(cwd, ['rev-list', '--count', `HEAD..${ref}`])).trim());
    if (behind === 0) {
      return { speech: es ? `Ya estás al día con ${base}.` : `You're already up to date with ${base}.` };
    }
    try {
      await git(cwd, ['merge', '--no-edit', ref], 60_000);
      return {
        speech: es
          ? `Listo, traje ${behind} commit${behind === 1 ? '' : 's'} de ${base} sin conflictos.`
          : `Done — merged ${behind} commit${behind === 1 ? '' : 's'} from ${base}, no conflicts.`,
      };
    } catch (err) {
      if (isOverwriteError(err)) {
        return {
          speech: es
            ? `No puedo traer ${base}: tus cambios sin commitear chocan. Haz commit, o di "guarda mis cambios" y lo intento de nuevo.`
            : `I can't merge ${base}: your uncommitted changes clash. Commit them, or say "stash my changes" and try again.`,
        };
      }
      const conflicts = await conflictedFiles(cwd);
      if (conflicts.length === 0) {
        return { speech: failed(es, err) };
      }
      const names = conflicts.slice(0, 3).map((f) => f.split('/').pop()).join(', ');
      return {
        speech: es
          ? `Traje ${base}, pero hay conflictos en ${conflicts.length} archivo${conflicts.length === 1 ? '' : 's'}: ${names}. ¿Quieres que el agente los resuelva?`
          : `I merged ${base}, but ${conflicts.length} file${conflicts.length === 1 ? ' has' : 's have'} conflicts: ${names}. Want the agent to resolve them?`,
        confirm: {
          description: `have the coding agent resolve the merge conflicts in ${conflicts.join(', ')}`,
          run: async () =>
            this.delegate(
              `A merge of ${ref} into the current branch left conflicts in: ${conflicts.join(', ')}. ` +
                'Resolve every conflict keeping the intent of both sides, make sure it builds/tests if that is quick, ' +
                'then stage the files and conclude the merge with `git commit --no-edit`.',
              es,
            ),
        },
      };
    }
  }

  async stash(es: boolean): Promise<VoiceOutcome> {
    const cwd = await repoRoot();
    if (!cwd) {
      return NOT_A_REPO(es);
    }
    if (!(await isDirty(cwd))) {
      return { speech: es ? 'No tienes cambios que guardar.' : 'You have no changes to set aside.' };
    }
    await git(cwd, ['stash', 'push', '--include-untracked', '-m', 'kato: stashed by voice']);
    return {
      speech: es
        ? 'Guardé tus cambios aparte. Di "recupera mis cambios" para traerlos de vuelta.'
        : 'Your changes are set aside. Say "bring my changes back" to restore them.',
    };
  }

  async unstash(es: boolean): Promise<VoiceOutcome> {
    const cwd = await repoRoot();
    if (!cwd) {
      return NOT_A_REPO(es);
    }
    const list = (await git(cwd, ['stash', 'list'])).trim();
    if (!list) {
      return { speech: es ? 'No hay cambios guardados aparte.' : 'There are no stashed changes.' };
    }
    const latest = list.split('\n')[0].replace(/^stash@\{0\}:\s*/, '');
    try {
      await git(cwd, ['stash', 'pop']);
      return { speech: es ? `Listo, recuperé tus cambios (${latest}).` : `Done — restored your changes (${latest}).` };
    } catch (err) {
      const conflicts = await conflictedFiles(cwd);
      return {
        speech: conflicts.length
          ? es
            ? `Recuperé tus cambios, pero chocan en ${conflicts.map((f) => f.split('/').pop()).join(', ')}. El stash sigue guardado por si acaso.`
            : `Restored your changes, but they conflict in ${conflicts.map((f) => f.split('/').pop()).join(', ')}. The stash is kept just in case.`
          : failed(es, err),
      };
    }
  }

  /** origin/<base> when it exists (after a quick fetch), else the local branch. */
  private async baseRef(cwd: string, base: string): Promise<string> {
    try {
      await git(cwd, ['fetch', '--quiet', 'origin', base], 20_000);
      await git(cwd, ['rev-parse', '--verify', '--quiet', `origin/${base}`]);
      return `origin/${base}`;
    } catch (err) {
      this.log(`[git] no origin/${base} (${String(err).slice(0, 80)}); using local ${base}`);
      return base;
    }
  }
}

/** "Feature Login" → "feature-login": what a spoken name becomes as a git ref. */
export function toBranchName(spoken: string): string {
  return spoken
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(la |the )?(rama|branch)\s+/, '')
    .replace(/\s*(slash|barra)\s*/g, '/')
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function failed(es: boolean, err: unknown): string {
  const message = err instanceof GitError ? err.message : String(err);
  return es ? `Git no me dejó: ${message.slice(0, 140)}` : `Git refused: ${message.slice(0, 140)}`;
}
