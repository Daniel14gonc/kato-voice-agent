import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findBinary } from '../agent/cliPaths';
import { getConfig, SECRET_KEYS, type KeyProvider } from '../config';
import { OPENAI_VOICES } from '../voice/voiceCatalog';

/**
 * First-run setup. Installing Kato used to mean: guess that the defaults
 * needed a Soniox key (the README said OpenAI was enough — it wasn't), answer
 * four API-key prompts in a row with no idea which ones mattered, and find out
 * the agent CLI was missing only when the first task failed. This module
 * detects what is already there, asks only for what is missing, validates
 * keys on the spot, and shows the state as a checklist in the panel.
 */

export interface SetupItem {
  label: string;
  ok: boolean;
  /** Missing but not blocking (Kato falls back to something else). */
  optional?: boolean;
  hint?: string;
}

export interface KeyPresence {
  openai: boolean;
  soniox: boolean;
  assemblyai: boolean;
  anthropic: boolean;
}

export async function keyPresence(secrets: vscode.SecretStorage): Promise<KeyPresence> {
  const has = async (provider: KeyProvider) => Boolean(await secrets.get(SECRET_KEYS[provider]));
  const [openai, soniox, assemblyai, anthropic] = await Promise.all([
    has('openai'),
    has('soniox'),
    has('assemblyai'),
    has('anthropic'),
  ]);
  return { openai, soniox, assemblyai, anthropic };
}

/**
 * The providers Kato will actually use: the configured one when its key is
 * there, otherwise OpenAI. A missing provider key used to break the mic
 * silently on a fresh install; now the default (AssemblyAI) just falls back.
 */
export function effectiveVoiceProviders(keys: KeyPresence): { stt: string; tts: string } {
  const config = getConfig();
  const sttOk =
    (config.sttProvider === 'soniox' && keys.soniox) ||
    (config.sttProvider === 'assemblyai' && keys.assemblyai) ||
    config.sttProvider === 'openai';
  const ttsOk = (config.ttsProvider === 'soniox' && keys.soniox) || config.ttsProvider === 'openai';
  return { stt: sttOk ? config.sttProvider : 'openai', tts: ttsOk ? config.ttsProvider : 'openai' };
}

const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  soniox: 'Soniox',
  assemblyai: 'AssemblyAI',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

// ---------- detection ----------

export interface AgentDetection {
  id: 'claude-code' | 'codex';
  installed: boolean;
  loggedIn: boolean;
  hint: string;
}

/** Best-effort: good enough to pick a default and to explain what is missing. */
export function detectAgents(es = true): AgentDetection[] {
  const home = os.homedir();
  const claudeCli = findBinary('claude', [path.join(home, '.claude', 'local')]);
  let claudeLoggedIn = Boolean(process.env.ANTHROPIC_API_KEY);
  try {
    const state = readFileSync(path.join(home, '.claude.json'), 'utf8');
    claudeLoggedIn ||= /"oauthAccount"\s*:\s*\{/.test(state) || /"primaryApiKey"/.test(state);
  } catch {
    // never ran claude on this machine
  }
  const codexCli = findBinary('codex');
  const codexLoggedIn = Boolean(process.env.OPENAI_API_KEY) || existsSync(path.join(home, '.codex', 'auth.json'));
  return [
    {
      id: 'claude-code',
      // The Agent SDK ships its own runtime, so a login is what really matters.
      installed: Boolean(claudeCli) || claudeLoggedIn,
      loggedIn: claudeLoggedIn,
      hint: claudeLoggedIn
        ? ''
        : claudeCli
          ? es
            ? 'Corre "claude" en una terminal una vez para iniciar sesión.'
            : 'Run "claude" in a terminal once to sign in.'
          : es
            ? 'Instala Claude Code (npm i -g @anthropic-ai/claude-code) y corre "claude" para iniciar sesión.'
            : 'Install Claude Code (npm i -g @anthropic-ai/claude-code) and run "claude" to sign in.',
    },
    {
      id: 'codex',
      installed: Boolean(codexCli) || codexLoggedIn,
      loggedIn: codexLoggedIn,
      hint: codexLoggedIn
        ? ''
        : codexCli
          ? es
            ? 'Corre "codex login" en una terminal.'
            : 'Run "codex login" in a terminal.'
          : es
            ? 'Instala Codex (npm i -g @openai/codex) y corre "codex login".'
            : 'Install Codex (npm i -g @openai/codex) and run "codex login".',
    },
  ];
}

export async function checkSetup(secrets: vscode.SecretStorage, es = true): Promise<SetupItem[]> {
  const keys = await keyPresence(secrets);
  const config = getConfig();
  const items: SetupItem[] = [];

  items.push({
    label: es ? 'Micrófono (ffmpeg)' : 'Microphone (ffmpeg)',
    ok: Boolean(findBinary('ffmpeg')),
    hint: es ? 'Instálalo con: brew install ffmpeg' : 'Install it with: brew install ffmpeg',
  });
  items.push({
    label: es ? 'API key de OpenAI' : 'OpenAI API key',
    ok: keys.openai,
    hint: es
      ? 'La usa el router de intenciones y las respuestas habladas.'
      : 'Kato uses it to understand requests and to answer.',
  });

  const voice = effectiveVoiceProviders(keys);
  for (const [kind, configured, effective] of [
    [es ? 'Transcripción' : 'Transcription', config.sttProvider, voice.stt],
    [es ? 'Voz' : 'Voice', config.ttsProvider, voice.tts],
  ] as const) {
    if (configured === 'openai') {
      continue;
    }
    items.push({
      label: `${kind}: ${PROVIDER_NAMES[configured] ?? configured}`,
      ok: configured === effective,
      optional: true,
      hint: es
        ? `Falta la key de ${PROVIDER_NAMES[configured] ?? configured}; mientras tanto uso OpenAI.`
        : `No ${PROVIDER_NAMES[configured] ?? configured} key yet; using OpenAI meanwhile.`,
    });
  }

  const agent = detectAgents(es).find((candidate) => candidate.id === config.agentProvider);
  items.push({
    label: `${es ? 'Agente de código' : 'Coding agent'}: ${PROVIDER_NAMES[config.agentProvider] ?? config.agentProvider}`,
    ok: agent ? agent.loggedIn : false,
    hint:
      agent?.hint || (es ? 'Proveedor desconocido: revisa kato.agent.provider.' : 'Unknown provider: check kato.agent.provider.'),
  });
  return items;
}

// ---------- key validation ----------

type Validation = 'valid' | 'invalid' | 'unknown';

async function validateKey(provider: KeyProvider, key: string): Promise<Validation> {
  const requests: Partial<Record<KeyProvider, { url: string; headers: Record<string, string> }>> = {
    openai: { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } },
    soniox: { url: 'https://api.soniox.com/v1/tts-models', headers: { Authorization: `Bearer ${key}` } },
    assemblyai: { url: 'https://api.assemblyai.com/v2/transcript?limit=1', headers: { Authorization: key } },
  };
  const request = requests[provider];
  if (!request) {
    return 'unknown';
  }
  try {
    const response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(8000) });
    if (response.status === 401 || response.status === 403) {
      return 'invalid';
    }
    return response.ok ? 'valid' : 'unknown';
  } catch {
    return 'unknown'; // offline or blocked: don't reject a key we couldn't check
  }
}

const KEY_INFO: Record<KeyProvider, { title: string; placeholder: string; url: string }> = {
  openai: { title: 'OpenAI', placeholder: 'sk-...', url: 'https://platform.openai.com/api-keys' },
  soniox: { title: 'Soniox', placeholder: '', url: 'https://console.soniox.com' },
  assemblyai: { title: 'AssemblyAI', placeholder: '', url: 'https://www.assemblyai.com/app/api-keys' },
  anthropic: { title: 'Anthropic', placeholder: 'sk-ant-...', url: 'https://console.anthropic.com/settings/keys' },
};

/**
 * Asks for one key, validates it, and re-asks on a clear rejection. Resolves
 * true when a key is stored (or already was), false when the user backs out.
 */
export async function promptForKey(
  secrets: vscode.SecretStorage,
  provider: KeyProvider,
  why: string,
  step?: string,
): Promise<boolean> {
  const info = KEY_INFO[provider];
  let error = '';
  for (;;) {
    const key = await vscode.window.showInputBox({
      title: `Kato${step ? ` (${step})` : ''}: API key de ${info.title}`,
      prompt: `${error ? `${error} ` : ''}${why} Consíguela en ${info.url}. Se guarda en el SecretStorage de VS Code.`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: info.placeholder,
    });
    if (!key?.trim()) {
      return false;
    }
    const trimmed = key.trim();
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Kato: verificando la key de ${info.title}…` },
      () => validateKey(provider, trimmed),
    );
    if (result === 'invalid') {
      error = `${info.title} rechazó esa key.`;
      continue;
    }
    await secrets.store(SECRET_KEYS[provider], trimmed);
    if (result === 'unknown') {
      void vscode.window.showWarningMessage(`Kato: guardé la key de ${info.title}, pero no pude verificarla ahora.`);
    }
    return true;
  }
}

// ---------- the wizard ----------

interface Pick<T> extends vscode.QuickPickItem {
  value: T;
}

async function pickOne<T>(title: string, items: Array<Pick<T>>, placeHolder?: string): Promise<T | undefined> {
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder, ignoreFocusOut: true });
  return picked?.value;
}

/**
 * The guided setup: voice stack → keys (only the missing ones) → coding agent
 * → how much it may do without asking. Every step shows what was detected, so
 * a returning user can just press Enter through it. Resolves true when Kato
 * is ready to talk.
 */
export async function runSetupWizard(secrets: vscode.SecretStorage): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('kato');
  const keys = await keyPresence(secrets);
  const set = (key: string, value: unknown) => cfg.update(key, value, vscode.ConfigurationTarget.Global);
  const tick = (ok: boolean) => (ok ? '$(check) key guardada' : '');

  // 1. Voice stack.
  const stack = await pickOne<'openai' | 'assemblyai' | 'soniox'>(
    'Kato (1/4): ¿con qué quieres que escuche y hable?',
    [
      {
        label: 'AssemblyAI para escuchar + OpenAI (recomendado)',
        description: tick(keys.assemblyai),
        detail: 'Universal-3.5 Pro en streaming: entiende el spanglish técnico y los nombres de tu código. Dos keys.',
        value: 'assemblyai',
      },
      {
        label: 'Solo OpenAI',
        description: tick(keys.openai),
        detail: 'Una sola API key. Lo más simple para empezar.',
        value: 'openai',
      },
      {
        label: 'Soniox para escuchar y hablar + OpenAI',
        description: tick(keys.soniox),
        detail: 'La latencia más baja y voces de Soniox. Dos keys.',
        value: 'soniox',
      },
    ],
    'OpenAI siempre hace falta: con ella Kato entiende qué le pides.',
  );
  if (!stack) {
    return false;
  }

  // 2. Keys — only the missing ones.
  if (!keys.openai) {
    const ok = await promptForKey(secrets, 'openai', 'Kato la usa para entender lo que pides y responderte.', '2/4');
    if (!ok) {
      return false;
    }
  }
  if (stack !== 'openai' && !keys[stack]) {
    const ok = await promptForKey(secrets, stack, 'Para la voz de Kato.', '2/4');
    if (!ok) {
      void vscode.window.showInformationMessage(`Kato: sin key de ${PROVIDER_NAMES[stack]}, uso OpenAI para la voz.`);
    }
  }
  await set('stt.provider', stack);
  const ttsProvider = stack === 'soniox' ? 'soniox' : 'openai';
  await set('tts.provider', ttsProvider);
  // Voice names are per provider: a Soniox voice fails on OpenAI and back.
  const isOpenAiVoice = OPENAI_VOICES.some((voice) => voice.id === getConfig().ttsVoice);
  if (ttsProvider === 'openai' && !isOpenAiVoice) {
    await set('tts.voice', 'nova');
  } else if (ttsProvider === 'soniox' && isOpenAiVoice) {
    await set('tts.voice', undefined); // back to the Soniox default
  }

  // 3. Coding agent.
  const agents = detectAgents();
  const current = getConfig().agentProvider;
  const agentPick = await pickOne<'claude-code' | 'codex'>(
    'Kato (3/4): ¿qué agente de código hace el trabajo?',
    agents
      .map((agent) => ({
        label: PROVIDER_NAMES[agent.id],
        description: agent.loggedIn ? '$(check) listo' : agent.installed ? 'falta iniciar sesión' : 'no instalado',
        detail: agent.hint || (agent.id === current ? 'El que usas ahora.' : undefined),
        value: agent.id,
      }))
      .sort((a, b) => Number(b.description.startsWith('$(check)')) - Number(a.description.startsWith('$(check)'))),
    'Kato nunca escribe código: delega en este agente.',
  );
  if (!agentPick) {
    return false;
  }
  await set('agent.provider', agentPick);
  const chosen = agents.find((agent) => agent.id === agentPick);
  if (chosen && !chosen.loggedIn) {
    const action = await vscode.window.showWarningMessage(
      `Kato: ${PROVIDER_NAMES[agentPick]} todavía no está listo. ${chosen.hint}`,
      'Abrir terminal',
    );
    if (action === 'Abrir terminal') {
      const terminal = vscode.window.createTerminal('Kato setup');
      terminal.show();
      terminal.sendText(agentPick === 'codex' ? 'codex login' : 'claude', false);
    }
  }

  // 4. Permission level.
  const mode = await pickOne<string>(
    'Kato (4/4): ¿cuánto puede hacer el agente sin preguntarte?',
    [
      {
        label: 'Normal',
        description: '(recomendado)',
        detail: 'Edita archivos solo. Te pregunta antes de correr comandos que cambian cosas; los de solo lectura nunca.',
        value: 'agent',
      },
      {
        label: 'Automático',
        detail: 'Nunca te pregunta. Ves cada acción en el panel y puedes decir "detente" cuando quieras.',
        value: 'auto',
      },
      {
        label: 'Manual',
        detail: 'Te pregunta por voz antes de cada acción, ediciones incluidas.',
        value: 'ask',
      },
    ],
    'Lo puedes cambiar después por voz: "ponlo en automático", "modo normal".',
  );
  if (mode) {
    await set('agent.defaultMode', mode);
  }
  return true;
}
