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
export function detectAgents(): AgentDetection[] {
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
          ? 'Run "claude" in a terminal once to sign in.'
          : 'Install Claude Code (npm i -g @anthropic-ai/claude-code) and run "claude" to sign in.',
    },
    {
      id: 'codex',
      installed: Boolean(codexCli) || codexLoggedIn,
      loggedIn: codexLoggedIn,
      hint: codexLoggedIn
        ? ''
        : codexCli
          ? 'Run "codex login" in a terminal.'
          : 'Install Codex (npm i -g @openai/codex) and run "codex login".',
    },
  ];
}

export async function checkSetup(secrets: vscode.SecretStorage): Promise<SetupItem[]> {
  const keys = await keyPresence(secrets);
  const config = getConfig();
  const items: SetupItem[] = [];

  items.push({
    label: 'Microphone (ffmpeg)',
    ok: Boolean(findBinary('ffmpeg')),
    hint: 'Install it with: brew install ffmpeg',
  });
  items.push({
    label: 'OpenAI API key',
    ok: keys.openai,
    hint: 'Kato uses it to understand requests and to answer.',
  });

  const voice = effectiveVoiceProviders(keys);
  for (const [kind, configured, effective] of [
    ['Transcription', config.sttProvider, voice.stt],
    ['Voice', config.ttsProvider, voice.tts],
  ] as const) {
    if (configured === 'openai') {
      continue;
    }
    items.push({
      label: `${kind}: ${PROVIDER_NAMES[configured] ?? configured}`,
      ok: configured === effective,
      optional: true,
      hint: `No ${PROVIDER_NAMES[configured] ?? configured} key yet; using OpenAI meanwhile.`,
    });
  }

  const agent = detectAgents().find((candidate) => candidate.id === config.agentProvider);
  items.push({
    label: `Coding agent: ${PROVIDER_NAMES[config.agentProvider] ?? config.agentProvider}`,
    ok: agent ? agent.loggedIn : false,
    hint: agent?.hint || 'Unknown provider: check kato.agent.provider.',
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
      title: `Kato${step ? ` (${step})` : ''}: ${info.title} API key`,
      prompt: `${error ? `${error} ` : ''}${why} Get one at ${info.url}. It's stored in VS Code's secret storage.`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: info.placeholder,
    });
    if (!key?.trim()) {
      return false;
    }
    const trimmed = key.trim();
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Kato: checking the ${info.title} key…` },
      () => validateKey(provider, trimmed),
    );
    if (result === 'invalid') {
      error = `${info.title} rejected that key.`;
      continue;
    }
    await secrets.store(SECRET_KEYS[provider], trimmed);
    if (result === 'unknown') {
      void vscode.window.showWarningMessage(`Kato: saved the ${info.title} key, but couldn't verify it right now.`);
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
  const tick = (ok: boolean) => (ok ? '$(check) key saved' : '');

  // 1. Voice stack.
  const stack = await pickOne<'openai' | 'assemblyai' | 'soniox'>(
    'Kato (1/4): how should Kato listen and speak?',
    [
      {
        label: 'AssemblyAI to listen + OpenAI (recommended)',
        description: tick(keys.assemblyai),
        detail: 'Universal-3.5 Pro streaming: handles technical English/Spanish and the names in your code. Two keys.',
        value: 'assemblyai',
      },
      {
        label: 'OpenAI only',
        description: tick(keys.openai),
        detail: 'A single API key. The simplest way to start.',
        value: 'openai',
      },
      {
        label: 'Soniox to listen and speak + OpenAI',
        description: tick(keys.soniox),
        detail: 'The lowest latency, with Soniox voices. Two keys.',
        value: 'soniox',
      },
    ],
    'OpenAI is always needed: Kato uses it to understand what you ask.',
  );
  if (!stack) {
    return false;
  }

  // 2. Keys — only the missing ones.
  if (!keys.openai) {
    const ok = await promptForKey(secrets, 'openai', 'Kato uses it to understand what you ask and to answer.', '2/4');
    if (!ok) {
      return false;
    }
  }
  if (stack !== 'openai' && !keys[stack]) {
    const ok = await promptForKey(secrets, stack, "For Kato's voice.", '2/4');
    if (!ok) {
      void vscode.window.showInformationMessage(`Kato: no ${PROVIDER_NAMES[stack]} key, so OpenAI handles the voice.`);
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
    'Kato (3/4): which coding agent does the work?',
    agents
      .map((agent) => ({
        label: PROVIDER_NAMES[agent.id],
        description: agent.loggedIn ? '$(check) ready' : agent.installed ? 'not signed in' : 'not installed',
        detail: agent.hint || (agent.id === current ? 'The one you use now.' : undefined),
        value: agent.id,
      }))
      .sort((a, b) => Number(b.description.startsWith('$(check)')) - Number(a.description.startsWith('$(check)'))),
    'Kato never writes code itself: it hands the work to this agent.',
  );
  if (!agentPick) {
    return false;
  }
  await set('agent.provider', agentPick);
  const chosen = agents.find((agent) => agent.id === agentPick);
  if (chosen && !chosen.loggedIn) {
    const action = await vscode.window.showWarningMessage(
      `Kato: ${PROVIDER_NAMES[agentPick]} isn't ready yet. ${chosen.hint}`,
      'Open terminal',
    );
    if (action === 'Open terminal') {
      const terminal = vscode.window.createTerminal('Kato setup');
      terminal.show();
      terminal.sendText(agentPick === 'codex' ? 'codex login' : 'claude', false);
    }
  }

  // 4. Permission level.
  const mode = await pickOne<string>(
    'Kato (4/4): how much may the agent do without asking?',
    [
      {
        label: 'Normal',
        description: '(recommended)',
        detail: 'Edits files freely. Asks before commands that change things; read-only ones never ask.',
        value: 'agent',
      },
      {
        label: 'Auto',
        detail: 'Never asks. Every action shows in the panel, and you can say "stop" at any time.',
        value: 'auto',
      },
      {
        label: 'Manual',
        detail: 'Asks by voice before every action, edits included.',
        value: 'ask',
      },
    ],
    'You can change it later by voice: "put it on auto", "normal mode".',
  );
  if (mode) {
    await set('agent.defaultMode', mode);
  }
  return true;
}
