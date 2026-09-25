import * as vscode from 'vscode';

const OPENAI_KEY_SECRET = 'kato.openaiApiKey';
const SONIOX_KEY_SECRET = 'kato.sonioxApiKey';
const ANTHROPIC_KEY_SECRET = 'kato.anthropicApiKey';
const ASSEMBLYAI_KEY_SECRET = 'kato.assemblyaiApiKey';

export interface KatoConfig {
  routerModel: string;
  explainerModel: string;
  anthropicExplainerModel: string;
  llmProvider: string;
  ttsProvider: string;
  ttsSonioxModel: string;
  sttProvider: string;
  sttModel: string;
  sttSonioxModel: string;
  sttAssemblyaiModel: string;
  sttSilenceMs: number;
  sttLanguage: string;
  sttPrompt: string;
  ttsModel: string;
  ttsVoice: string;
  ttsInstructions: string;
  micDevice: string;
  agentProvider: string;
  agentModel: string;
  agentCliPath: string;
  tourGranularity: string;
}

export function getConfig(): KatoConfig {
  const cfg = vscode.workspace.getConfiguration('kato');
  return {
    routerModel: cfg.get<string>('models.router', 'gpt-4.1-mini'),
    explainerModel: cfg.get<string>('models.explainer', 'gpt-5.6-luna'),
    anthropicExplainerModel: cfg.get<string>('models.anthropicExplainer', 'claude-haiku-4-5'),
    llmProvider: cfg.get<string>('llm.provider', 'openai'),
    ttsProvider: cfg.get<string>('tts.provider', 'soniox'),
    ttsSonioxModel: cfg.get<string>('tts.sonioxModel', 'tts-rt-v2'),
    sttProvider: cfg.get<string>('stt.provider', 'soniox'),
    sttModel: cfg.get<string>('stt.model', 'gpt-4o-transcribe'),
    sttSonioxModel: cfg.get<string>('stt.sonioxModel', 'stt-rt-v5'),
    sttAssemblyaiModel: cfg.get<string>('stt.assemblyaiModel', 'universal-3-5-pro'),
    sttSilenceMs: cfg.get<number>('stt.silenceMs', 500),
    sttLanguage: cfg.get<string>('stt.language', ''),
    sttPrompt: cfg.get<string>(
      'stt.prompt',
      'The speaker is a programmer who talks in Spanish and English, often mixed. The only possible languages are Spanish and English. Technical terms, identifiers and product names stay in English.',
    ),
    ttsModel: cfg.get<string>('tts.model', 'gpt-4o-mini-tts'),
    ttsVoice: cfg.get<string>('tts.voice', 'Logan'),
    ttsInstructions: cfg.get<string>(
      'tts.instructions',
      'Speak fast, with an energetic and natural conversational pace, like a colleague pair-programming. Never drag words or pause dramatically. Pronounce code identifiers in English.',
    ),
    micDevice: cfg.get<string>('mic.device', ''),
    agentProvider: cfg.get<string>('agent.provider', 'claude-code'),
    agentModel: cfg.get<string>('agent.model', ''),
    agentCliPath: cfg.get<string>('agent.cliPath', ''),
    tourGranularity: cfg.get<string>('tour.granularity', 'auto'),
  };
}

export async function getOpenAIKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(OPENAI_KEY_SECRET);
}

export async function ensureOpenAIKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const existing = await getOpenAIKey(context);
  if (existing) {
    return existing;
  }
  return promptForOpenAIKey(context);
}

export async function promptForOpenAIKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: 'Kato: OpenAI API Key',
    prompt: 'Used for text-to-speech and Kato’s internal models. Stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-...',
  });
  if (key && key.trim()) {
    await context.secrets.store(OPENAI_KEY_SECRET, key.trim());
    void vscode.window.showInformationMessage('Kato: OpenAI API key saved.');
    return key.trim();
  }
  return undefined;
}

export async function getSonioxKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SONIOX_KEY_SECRET);
}

export async function getAnthropicKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(ANTHROPIC_KEY_SECRET);
}

export async function promptForAnthropicKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: 'Kato: Anthropic API Key',
    prompt: 'Used for spoken answers (kato.llm.provider = anthropic). Leave empty to skip. Stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-ant-...',
  });
  if (key && key.trim()) {
    await context.secrets.store(ANTHROPIC_KEY_SECRET, key.trim());
    void vscode.window.showInformationMessage('Kato: Anthropic API key saved.');
    return key.trim();
  }
  return undefined;
}

export async function getAssemblyAiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(ASSEMBLYAI_KEY_SECRET);
}

export async function promptForAssemblyAiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: 'Kato: AssemblyAI API Key',
    prompt: 'Used for speech-to-text (kato.stt.provider = assemblyai). Leave empty to skip. Stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
  });
  if (key && key.trim()) {
    await context.secrets.store(ASSEMBLYAI_KEY_SECRET, key.trim());
    void vscode.window.showInformationMessage('Kato: AssemblyAI API key saved.');
    return key.trim();
  }
  return undefined;
}

export async function promptForSonioxKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: 'Kato: Soniox API Key',
    prompt: 'Used for speech-to-text (kato.stt.provider = soniox). Leave empty to skip. Stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
  });
  if (key && key.trim()) {
    await context.secrets.store(SONIOX_KEY_SECRET, key.trim());
    void vscode.window.showInformationMessage('Kato: Soniox API key saved.');
    return key.trim();
  }
  return undefined;
}
