import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getAnthropicKey, getAssemblyAiKey, getConfig, getOpenAIKey, getSonioxKey, type KeyProvider } from './config';
import { AgentManager } from './agent/agentManager';
import { ClaudeCodeAgent } from './agent/providers/claudeCode';
import { ClaudeCodeSessionProvider } from './agent/providers/claudeCodeSession';
import { CodexExploreAgent, CodexSessionProvider } from './agent/providers/codexSession';
import { TestRunner } from './commands/testRunner';
import { ContextEngine } from './context/contextEngine';
import { DebugController } from './explore/debugController';
import { ReferentStore } from './conversation/referents';
import { ConversationSession } from './conversation/session';
import { DeepUnderstanding } from './explore/deepUnderstanding';
import { TourEngine } from './explore/tourEngine';
import { AnthropicLlm } from './llm/anthropic';
import { LlmRouter } from './llm/llmRouter';
import { OpenAILlm } from './llm/openai';
import { IntentExecutor } from './router/executor';
import { IntentRouter, quickAgentIntent } from './router/intentRouter';
import {
  checkSetup,
  effectiveVoiceProviders,
  keyPresence,
  promptForKey,
  runSetupWizard,
  type KeyPresence,
} from './setup/setup';
import { KatoStatusBar } from './ui/statusBar';
import { AssemblyAiStt } from './voice/assemblyaiStt';
import { AudioBridge } from './voice/audioBridge';
import { MicCapture } from './voice/micCapture';
import { OpenAIRealtimeStt } from './voice/openaiRealtimeStt';
import { OpenAITts } from './voice/openaiTts';
import { SonioxStt } from './voice/sonioxStt';
import { SonioxTts } from './voice/sonioxTts';
import { SttRouter } from './voice/sttRouter';
import { listSonioxVoices, OPENAI_VOICES, type VoiceOption } from './voice/voiceCatalog';
import { TtsRouter } from './voice/ttsRouter';
import { VoicePipeline } from './voice/voicePipeline';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Kato');
  const getKey = () => getOpenAIKey(context);

  const bridge = new AudioBridge(context.extensionUri);
  const log = (msg: string) => {
    channel.appendLine(msg);
    // Test runs surface in the panel history too. Agent activity no longer
    // rides on this regex: it has its own typed protocol (see AgentUi below),
    // which is what lets the panel show tool state, streamed prose and the
    // actual command behind a permission request.
    const activity = msg.match(/^\[tests\] (.+)$/);
    if (activity) {
      bridge.showActivity(activity[1]);
    }
  };
  // Which keys exist decides which voice providers really run: a configured
  // provider without its key falls back to OpenAI instead of failing.
  let keys: KeyPresence = { openai: false, soniox: false, assemblyai: false, anthropic: false };
  const voiceProviders = () => effectiveVoiceProviders(keys);
  const refreshSetup = async () => {
    keys = await keyPresence(context.secrets);
    bridge.setupStatus(await checkSetup(context.secrets));
  };

  const mic = new MicCapture();
  const stt = new SttRouter(
    {
      openai: new OpenAIRealtimeStt(getKey, log),
      soniox: new SonioxStt(() => getSonioxKey(context), log),
      assemblyai: new AssemblyAiStt(() => getAssemblyAiKey(context), log),
    },
    () => voiceProviders().stt,
  );
  const tts = new TtsRouter(
    {
      openai: new OpenAITts(getKey),
      soniox: new SonioxTts(() => getSonioxKey(context)),
    },
    () => voiceProviders().tts,
  );
  const llm = new LlmRouter(
    {
      openai: new OpenAILlm(getKey),
      anthropic: new AnthropicLlm(() => getAnthropicKey(context)),
    },
    () => getConfig().llmProvider,
  );
  const referents = new ReferentStore();
  const contextEngine = new ContextEngine(referents);
  const session = new ConversationSession();
  const intentRouter = new IntentRouter(getKey, () => getConfig().routerModel);
  const tour = new TourEngine(referents);
  let notify: (text: string, options?: { replaceKey?: string }) => void = () => {};
  const agentOutput = vscode.window.createOutputChannel('Kato Agent');
  const statusBar = new KatoStatusBar();
  const agents = new AgentManager(
    {
      'claude-code': new ClaudeCodeSessionProvider(log, () => getConfig().agentCliPath),
      codex: new CodexSessionProvider(log),
    },
    () => ({ provider: getConfig().agentProvider, model: getConfig().agentModel }),
    log,
    (text, options) => notify(text, options),
    agentOutput,
    {
      status: (update) => {
        bridge.agentStatus(update);
        statusBar.updateAgent(update);
      },
      tool: (event) => bridge.agentTool(event),
      text: (delta) => bridge.agentText(delta),
      permission: (request) => bridge.agentPermission(request),
      todos: (todos) => bridge.agentTodos(todos),
      milestone: (text) => bridge.agentMilestone(text),
      reveal: () => bridge.reveal(),
    },
  );
  const tests = new TestRunner(context.workspaceState, llm, log, (text) => notify(text));
  const debugCtl = new DebugController((text) => notify(text), log);
  const executor = new IntentExecutor(
    referents,
    tour,
    llm,
    agents,
    tests,
    debugCtl,
    (placeholder, question) => bridge.requestInput(placeholder, question),
    (line) => bridge.showActivity(line),
  );
  const deep = new DeepUnderstanding(
    {
      'claude-code': new ClaudeCodeAgent(() => getConfig().agentCliPath),
      codex: new CodexExploreAgent(),
    },
    () => ({ provider: getConfig().agentProvider, model: getConfig().agentModel }),
    context.workspaceState,
    log,
    {
      begin: (question, provider, es) => agents.beginExploration(question, provider, es),
      activity: (activity) => agents.explorationActivity(activity),
      end: (ok) => agents.endExploration(ok),
    },
  );
  const pipeline = new VoicePipeline(
    bridge,
    mic,
    stt,
    tts,
    llm,
    {
      context: contextEngine,
      session,
      router: intentRouter,
      executor,
      deep,
      tour,
      extraStatusLines: () => [
        agents.statusLine(),
        tests.statusLine(),
        debugCtl.statusLine(),
        executor.pendingConfirmationLine(),
      ],
      // A bare "sí" while the agent is parked never reaches the LLM: it used to
      // cost a second and sometimes came back as confirm_action, which silently
      // dropped the approval.
      fastIntent: (transcript) => quickAgentIntent(transcript, agents.waitingApproval),
    },
    channel,
    voiceProviders,
  );
  notify = (text, options) => pipeline.speakNotification(text, undefined, options);

  const setup = async (): Promise<boolean> => {
    const done = await runSetupWizard(context.secrets);
    await refreshSetup();
    if (done) {
      void vscode.window.showInformationMessage('Kato está listo. Pulsa Ctrl+; y pídeme algo.');
    }
    return done;
  };

  pipeline.onStateChange((state) => statusBar.update(state));

  context.subscriptions.push(
    channel,
    agentOutput,
    statusBar,
    vscode.window.registerWebviewViewProvider(AudioBridge.viewId, bridge, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('kato.toggleTalk', async () => {
      if (!(await getKey())) {
        // First press on a fresh install: walk through setup instead of a
        // bare "paste your key" box with no context.
        if (!(await setup()) || !(await getKey())) {
          return;
        }
      }
      await pipeline.toggle();
    }),
    vscode.commands.registerCommand('kato.setup', () => setup()),
    vscode.commands.registerCommand('kato.showAgentOutput', () => agentOutput.show(true)),
    vscode.commands.registerCommand('kato.showPanel', () => vscode.commands.executeCommand('kato.audio.focus')),
    vscode.commands.registerCommand('kato.cancel', () => pipeline.cancel()),
    vscode.commands.registerCommand('kato.typeMessage', () => bridge.requestInput('')),
    vscode.commands.registerCommand('kato.chooseVoice', async () => {
      const config = getConfig();
      let voices: VoiceOption[];
      try {
        if (config.ttsProvider === 'soniox') {
          const sonioxKey = await getSonioxKey(context);
          if (!sonioxKey) {
            void vscode.window.showWarningMessage('Kato: configura primero la API key de Soniox.');
            return;
          }
          voices = await listSonioxVoices(sonioxKey, config.ttsSonioxModel);
        } else {
          voices = OPENAI_VOICES;
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Kato: no pude leer el catálogo de voces — ${String(err)}`);
        return;
      }
      if (voices.length === 0) {
        void vscode.window.showWarningMessage('Kato: el proveedor no devolvió voces.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        voices.map((voice) => ({
          label: voice.id,
          description: voice.gender,
          detail: voice.description,
          picked: voice.id === config.ttsVoice,
        })),
        {
          title: 'Kato: elige una voz',
          placeHolder: 'Escribe "male" o "female" para filtrar por género',
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (!picked) {
        return;
      }
      await vscode.workspace
        .getConfiguration('kato')
        .update('tts.voice', picked.label, vscode.ConfigurationTarget.Global);
      // Audition it right away: reading it aloud is the only real test.
      pipeline.speakNotification(
        `Hola, soy ${picked.label}. Así sueno leyendo tu código y explicándote lo que hace.`,
        'es',
      );
    }),
    vscode.commands.registerCommand('kato.configureApiKeys', async () => {
      // One key at a time, chosen from a list that says what each one is for.
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'OpenAI', detail: 'Obligatoria: router de intenciones, respuestas y voz por defecto.', value: 'openai' as KeyProvider, description: keys.openai ? '$(check) guardada' : '' },
          { label: 'AssemblyAI', detail: 'Transcripción (kato.stt.provider = assemblyai).', value: 'assemblyai' as KeyProvider, description: keys.assemblyai ? '$(check) guardada' : '' },
          { label: 'Soniox', detail: 'Transcripción y voz (kato.stt/tts.provider = soniox).', value: 'soniox' as KeyProvider, description: keys.soniox ? '$(check) guardada' : '' },
          { label: 'Anthropic', detail: 'Respuestas habladas con Claude (kato.llm.provider = anthropic).', value: 'anthropic' as KeyProvider, description: keys.anthropic ? '$(check) guardada' : '' },
        ],
        { title: 'Kato: ¿qué API key quieres configurar?' },
      );
      if (picked) {
        await promptForKey(context.secrets, picked.value, '');
        await refreshSetup();
      }
    }),
    vscode.commands.registerCommand('kato.showLog', () => channel.show()),
    vscode.commands.registerCommand('kato.evalRouter', async () => {
      const key = await getKey();
      if (!key) {
        void vscode.window.showWarningMessage('Kato: configura primero la API key de OpenAI.');
        return;
      }
      const evalOutput = vscode.window.createOutputChannel('Kato Eval');
      evalOutput.show(true);
      evalOutput.appendLine('Running router evaluation…\n');
      // The extension host binary doubles as node, so this needs no system node.
      const child = spawn(process.execPath, [path.join(context.extensionPath, 'dist', 'eval-router.js')], {
        cwd: context.extensionPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: key },
      });
      child.stdout.on('data', (data: Buffer) => evalOutput.append(data.toString('utf8')));
      child.stderr.on('data', (data: Buffer) => evalOutput.append(data.toString('utf8')));
      child.on('close', (code) => evalOutput.appendLine(`\n(eval finished with exit code ${code})`));
    }),
    vscode.commands.registerCommand('kato.forgetTestCommand', async () => {
      await tests.forgetCommand();
      void vscode.window.showInformationMessage('Kato: olvidé el comando de tests; te lo preguntaré la próxima vez.');
    }),
    vscode.commands.registerCommand('kato.clearRepoNotes', async () => {
      await deep.clearNotes();
      void vscode.window.showInformationMessage('Kato: notas del repo olvidadas. La próxima exploración parte de cero.');
    }),
    { dispose: () => debugCtl.dispose() },
    { dispose: () => pipeline.dispose() },
    { dispose: () => tour.dispose() },
    { dispose: () => agents.dispose() },
  );

  context.subscriptions.push(
    context.secrets.onDidChange(() => void refreshSetup()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('kato')) {
        void refreshSetup();
      }
    }),
  );
  void refreshSetup().then(() => {
    if (!keys.openai && !context.globalState.get('kato.setupPrompted')) {
      void context.globalState.update('kato.setupPrompted', true);
      void vscode.window
        .showInformationMessage('Kato: configúralo en un minuto (voz, API keys y agente de código).', 'Configurar')
        .then((choice) => (choice ? setup() : undefined));
    }
  });

  channel.appendLine('Kato activated.');
}

export function deactivate(): void {}
