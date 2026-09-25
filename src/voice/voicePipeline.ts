import * as vscode from 'vscode';
import { getConfig } from '../config';
import type { ContextEngine } from '../context/contextEngine';
import type { ConversationSession } from '../conversation/session';
import type { DeepUnderstanding, TourGranularity } from '../explore/deepUnderstanding';
import type { TourEngine } from '../explore/tourEngine';
import type { LlmProvider } from '../llm/llmProvider';
import type { IntentExecutor } from '../router/executor';
import type { Intent, IntentRouter } from '../router/intentRouter';
import { UtteranceMetrics } from '../util/metrics';
import type { AudioBridge, PipelineState } from './audioBridge';
import type { MicCapture } from './micCapture';
import { SentenceStream } from './sentenceStream';
import type { SttProvider } from './sttProvider';
import type { TtsProvider } from './ttsProvider';

/** The "brain": eyes (context), memory (session), routing, execution, agents. */
export interface IntentEngine {
  context: ContextEngine;
  session: ConversationSession;
  router: IntentRouter;
  executor: IntentExecutor;
  deep: DeepUnderstanding;
  tour: TourEngine;
  /** Extra snapshot lines (agent, tests, pending confirmation); empty ones are dropped. */
  extraStatusLines(): string[];
  /**
   * An intent Kato can decide locally, skipping the router round-trip. Used for
   * bare yes/no while the agent waits for approval, where the LLM was both slow
   * and wrong.
   */
  fastIntent(transcript: string): Intent | undefined;
}

/**
 * M0 voice loop state machine:
 * idle → listening → thinking → speaking → idle, with cancellation (Esc) and
 * barge-in (toggle while speaking) from any busy state.
 */
export class VoicePipeline {
  private state: PipelineState = 'idle';
  private metrics: UtteranceMetrics | undefined;
  private abort: AbortController | undefined;
  private ttsQueue: Promise<void> = Promise.resolve();
  private streamingDone = true;
  private audioIdle = true;
  // Callbacks fired when a sentence's audio actually starts (tour highlights).
  private sentenceIdCounter = 0;
  private readonly sentenceCallbacks = new Map<number, () => void>();

  /** True while a listening session is being opened (several awaits long). */
  private starting = false;
  /** Bumped by every start-up and every cancel, so a superseded start-up can
   * release the STT session it was opening instead of leaking it. */
  private startToken = 0;

  private readonly stateListeners: Array<(state: PipelineState) => void> = [];
  private readonly pendingNotifications: string[] = [];
  /** Last detected utterance language — notifications reuse it for TTS. */
  private lastLanguage: string | undefined;
  /** Candidate conversation language awaiting a second confirming detection. */
  private pendingLanguage: string | undefined;

  constructor(
    private readonly bridge: AudioBridge,
    private readonly mic: MicCapture,
    private readonly stt: SttProvider,
    private readonly tts: TtsProvider,
    private readonly llm: LlmProvider,
    private readonly brain: IntentEngine,
    private readonly channel: vscode.OutputChannel,
  ) {
    bridge.setEvents({
      onReady: () => {},
      onPlaybackStarted: () => {
        this.metrics?.mark('audioFirstPlay');
        this.metrics?.report();
        // A notification's playback would re-report the same utterance.
        this.metrics = undefined;
        this.setState('speaking');
      },
      onPlaybackEnded: () => {
        this.audioIdle = true;
        this.maybeFinishResponse();
      },
      onPlaybackError: (message) => {
        // The webview queues the audio while locked and replays it after the
        // user's click, so this is a nudge — the turn stays alive.
        this.channel.appendLine(`[playback error] ${message}`);
        void vscode.window.showWarningMessage(
          'Kato: haz click en el panel de Kato para habilitar el audio — la respuesta sonará al hacerlo.',
        );
      },
      onDiag: (message) => {
        this.channel.appendLine(`[webview] ${message}`);
      },
      onUserInput: (text) => void this.submitText(text),
      onSentenceStarted: (id) => {
        const callback = this.sentenceCallbacks.get(id);
        if (callback) {
          this.sentenceCallbacks.delete(id);
          callback();
        }
      },
    });
  }

  onStateChange(listener: (state: PipelineState) => void): void {
    this.stateListeners.push(listener);
  }

  private setState(state: PipelineState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.bridge.setStatus(state);
    void vscode.commands.executeCommand('setContext', 'kato.busy', state !== 'idle');
    for (const listener of this.stateListeners) {
      listener(state);
    }
    if (state === 'idle') {
      // Agent milestones queued while Kato was busy get spoken now.
      setTimeout(() => this.flushNotifications(), 400);
    }
  }

  /**
   * Speaks a spontaneous notification (agent milestones, permission requests).
   * If Kato is mid-conversation it queues and speaks when idle.
   */
  speakNotification(text: string, language?: string): void {
    if (language) {
      this.lastLanguage = language;
    }
    this.pendingNotifications.push(text);
    this.flushNotifications();
  }

  private flushNotifications(): void {
    if (this.state !== 'idle' || this.pendingNotifications.length === 0) {
      return;
    }
    const text = this.pendingNotifications.shift() as string;
    const config = getConfig();
    const abort = new AbortController();
    this.abort = abort;
    this.streamingDone = false;
    this.audioIdle = true;
    this.setState('thinking'); // busy state so toggle barge-in cancels cleanly
    this.bridge.answerStart();
    this.enqueueTts(text, config, abort, this.lastLanguage);
    void this.ttsQueue.then(() => {
      this.channel.appendLine(`Kato: ${text}`);
      this.brain.session.addAssistant(text);
      this.streamingDone = true;
      this.maybeFinishResponse();
    });
  }

  async toggle(): Promise<void> {
    switch (this.state) {
      case 'idle':
        if (this.starting) {
          // Second press while the session is still coming up. Starting a
          // second one used to leak the first STT socket, and a few of those
          // are enough to hit the provider's concurrent-session limit.
          this.cancel();
          return;
        }
        await this.startListening();
        break;
      case 'listening':
        this.toIdle();
        break;
      case 'thinking':
      case 'speaking':
        // Barge-in: kill the current answer and listen again.
        this.cancelResponse();
        await this.startListening();
        break;
    }
  }

  cancel(): void {
    this.cancelResponse();
    this.toIdle();
  }

  /**
   * Text typed or pasted in the panel. Takes the same path as a transcript —
   * the way to give Kato URLs, tokens and paths that are absurd to dictate.
   */
  async submitText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (this.state === 'listening') {
      this.mic.stop();
      this.stt.close();
    } else if (this.state !== 'idle') {
      this.cancelResponse();
    }
    this.metrics = undefined;
    this.setState('thinking');
    await this.respond(trimmed, this.lastLanguage);
  }

  private toIdle(): void {
    // Anything still being opened is now nobody's; the token check releases it.
    this.startToken++;
    this.mic.stop();
    // Soniox drops idle connections with a 408 after a few seconds of no
    // audio; close eagerly and reconnect on the next listen instead.
    this.stt.close();
    this.setState('idle');
  }

  private cancelResponse(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.bridge.stopAudio();
    this.sentenceCallbacks.clear();
    this.streamingDone = true;
    this.audioIdle = true;
  }

  private async startListening(): Promise<void> {
    this.starting = true;
    try {
      await this.openListeningSession(++this.startToken);
    } finally {
      this.starting = false;
    }
  }

  /**
   * True when a cancel or a newer start-up landed while we were awaiting. The
   * half-open session is released here rather than left connected to a pipeline
   * that has moved on.
   */
  private superseded(token: number): boolean {
    if (token === this.startToken) {
      return false;
    }
    this.stt.close();
    this.mic.stop();
    return true;
  }

  private async openListeningSession(token: number): Promise<void> {
    const config = getConfig();
    try {
      await this.bridge.ensureReady();
    } catch (err) {
      this.channel.appendLine(`[audio panel error] ${String(err)}`);
      void vscode.window.showErrorMessage(`Kato: ${String(err)}`);
      this.toIdle();
      return;
    }
    if (this.superseded(token)) {
      return;
    }
    // Bias transcription toward the identifiers on screen.
    const vocabulary = await this.brain.context.vocabulary().catch(() => [] as string[]);
    if (this.superseded(token)) {
      return;
    }
    try {
      await this.stt.connect(
        {
          model:
            config.sttProvider === 'soniox'
              ? config.sttSonioxModel
              : config.sttProvider === 'assemblyai'
                ? config.sttAssemblyaiModel
                : config.sttModel,
          language: config.sttLanguage,
          silenceMs: config.sttSilenceMs,
          prompt: config.sttPrompt,
          vocabulary,
        },
        {
          onSpeechStarted: () => {
            if (this.state === 'listening') {
              this.metrics = new UtteranceMetrics(this.channel);
            }
          },
          onSpeechStopped: () => {
            this.metrics?.mark('speechEnd');
          },
          onPartialTranscript: (text) => {
            if (this.state === 'listening') {
              this.bridge.showTranscript(text);
            }
          },
          onFinalTranscript: (text, language) => {
            if (this.state === 'listening') {
              this.mic.stop();
              this.stt.close();
              this.metrics?.mark('transcriptFinal');
              this.bridge.showTranscript(text);
              this.setState('thinking');
              void this.respond(text, language);
            }
          },
          onError: (message) => {
            this.channel.appendLine(`[stt error] ${message}`);
            // Providers report quota and auth failures as a frame just after
            // the socket opens, which can land before we reach 'listening'.
            // Swallowing those left the user with a mic that silently did
            // nothing.
            if (this.state === 'listening' || this.starting) {
              void vscode.window.showErrorMessage(`Kato STT: ${message}`);
              this.toIdle();
            }
          },
        },
      );
    } catch (err) {
      // A cancel mid-handshake fails the connect on purpose; that is not an
      // error worth putting in the user's face.
      if (this.superseded(token)) {
        return;
      }
      void vscode.window.showErrorMessage(`Kato: no pude conectar el STT (${String(err)})`);
      this.toIdle();
      return;
    }
    if (this.superseded(token)) {
      return;
    }
    this.mic.start(
      {
        onChunk: (chunk) => {
          if (this.state === 'listening') {
            this.stt.sendAudio(chunk);
          }
        },
        onLevel: (rms) => this.bridge.showLevel(rms),
        onError: (message) => {
          this.channel.appendLine(`[mic error] ${message}`);
          void vscode.window.showErrorMessage(`Kato: problema con el micrófono — ${message}`);
          this.toIdle();
        },
      },
      config.micDevice,
    );
    this.setState('listening');
  }

  /**
   * Language ID flips on one-word answers and anglicisms ("Okay, let's debug"
   * can come back as es), and a single wrong flip switches Kato's whole voice
   * mid-conversation. The conversation language therefore only changes when a
   * long-enough utterance detects a different language twice in a row; short
   * utterances and one-off detections follow the last confirmed language.
   */
  private stickyLanguage(transcript: string, detected?: string): string | undefined {
    const substantial = transcript.trim().length >= 20;
    if (detected && substantial) {
      if (!this.lastLanguage || detected === this.lastLanguage || this.pendingLanguage === detected) {
        this.lastLanguage = detected;
        this.pendingLanguage = undefined;
        return detected;
      }
      this.pendingLanguage = detected;
      return this.lastLanguage;
    }
    return this.lastLanguage ?? detected;
  }

  private async respond(transcript: string, language?: string): Promise<void> {
    const config = getConfig();
    language = this.stickyLanguage(transcript, language);
    this.channel.appendLine(`You: ${transcript}${language ? ` [${language}]` : ''}`);
    const abort = new AbortController();
    this.abort = abort;
    this.streamingDone = false;
    this.audioIdle = true;
    this.bridge.answerStart();

    this.brain.session.addUser(transcript);

    try {
      const snapshot = await this.brain.context.snapshot();
      // Enrich the snapshot with tour/agent state and cached repo knowledge so
      // both the router and the answer LLM see them.
      snapshot.text = [
        snapshot.text,
        this.brain.tour.statusLine(),
        ...this.brain.extraStatusLines(),
        this.brain.deep.notesLine(),
      ]
        .filter(Boolean)
        .join('\n');
      const routeStart = Date.now();
      let intent: Intent;
      const fast = this.brain.fastIntent(transcript);
      if (fast) {
        intent = fast;
        this.channel.appendLine(`[router] ${intent.tool} ${JSON.stringify(intent.args)} (local fast-path)`);
      } else {
        try {
          intent = await this.brain.router.route({
            transcript,
            snapshotText: snapshot.text,
            history: this.brain.session.history(),
            signal: abort.signal,
          });
          this.channel.appendLine(
            `[router] ${intent.tool} ${JSON.stringify(intent.args)} (${Date.now() - routeStart}ms)`,
          );
        } catch (err) {
          if (abort.signal.aborted) {
            return;
          }
          // The router failing must never kill the turn — degrade to a chat answer.
          this.channel.appendLine(`[router error] ${String(err)} — falling back to answer`);
          intent = { tool: 'answer', args: {} };
        }
      }

      const result = await this.brain.executor.execute(
        intent,
        snapshot,
        this.brain.session.history(),
        language,
        abort.signal,
        transcript,
      );
      if (abort.signal.aborted) {
        return;
      }

      if (result.kind === 'speech') {
        // Deterministic tools speak a template — no LLM between execution and TTS.
        this.metrics?.mark('llmFirstToken');
        for (const part of result.parts ?? [{ text: result.text }]) {
          this.enqueueTts(part.text, config, abort, language, part.onAudioStart);
        }
        await this.ttsQueue;
        this.channel.appendLine(`Kato: ${result.text}`);
        this.brain.session.addAssistant(result.text);
      } else if (result.kind === 'deep') {
        await this.respondDeep(result.question, config, abort, language, result.granularity);
      } else {
        const sentences = new SentenceStream((sentence) => this.enqueueTts(sentence, config, abort, language));
        const languageName = language === 'es' ? 'Spanish' : language === 'en' ? 'English' : language;
        const model =
          config.llmProvider === 'anthropic' ? config.anthropicExplainerModel : config.explainerModel;
        const messages = [...result.messages];
        if (languageName) {
          messages.splice(1, 0, {
            role: 'system',
            content: `The user's last utterance was detected as ${languageName}. Reply ONLY in ${languageName}.`,
          });
        }
        const answer = await this.llm.streamChat({
          model,
          messages,
          signal: abort.signal,
          onDelta: (delta) => {
            this.metrics?.mark('llmFirstToken');
            sentences.push(delta);
          },
        });
        sentences.flush();
        await this.ttsQueue;
        this.channel.appendLine(`Kato: ${answer}`);
        this.brain.session.addAssistant(answer);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        this.channel.appendLine(`[respond error] ${String(err)}`);
        void vscode.window.showErrorMessage(`Kato: ${String(err)}`);
        this.cancelResponse();
        this.toIdle();
        return;
      }
    }
    this.streamingDone = true;
    this.maybeFinishResponse();
  }

  /**
   * Deep understanding: spoken ack immediately, then the coding agent explores
   * the repo (10s–minutes, interruptible via toggle/Esc), and finally the
   * overview is spoken and the tour is loaded.
   */
  private async respondDeep(
    question: string,
    config: ReturnType<typeof getConfig>,
    abort: AbortController,
    language?: string,
    granularity?: TourGranularity,
  ): Promise<void> {
    const es = language !== 'en';
    this.metrics?.mark('llmFirstToken');
    this.enqueueTts(
      es
        ? 'Dame un momento, voy a explorar el proyecto con el agente. Te aviso en cuanto lo tenga.'
        : "Give me a moment — I'll explore the project with the agent and get back to you.",
      config,
      abort,
      language,
    );

    const deep = await this.brain.deep.explore(question, language, abort.signal, granularity);
    if (abort.signal.aborted) {
      return;
    }
    this.brain.tour.load(deep.stops);

    const tourIntro =
      deep.stops.length > 0
        ? es
          ? ` Preparé un tour de ${deep.stops.length} paradas por el código. Di "siguiente" para empezar.`
          : ` I prepared a ${deep.stops.length}-stop tour through the code. Say "next" to start.`
        : '';
    const intro = `${deep.overview}${tourIntro}`;
    // The result is a new message, not a continuation of the "give me a moment".
    const introSentences = new SentenceStream((sentence, index) =>
      this.enqueueTts(sentence, config, abort, language, undefined, index === 0),
    );
    introSentences.push(intro);
    introSentences.flush();
    await this.ttsQueue;
    this.channel.appendLine(`Kato: ${intro}`);
    this.brain.session.addAssistant(intro);
  }

  private enqueueTts(
    sentence: string,
    config: ReturnType<typeof getConfig>,
    abort: AbortController,
    language?: string,
    onAudioStart?: () => void,
    newBubble = false,
  ): void {
    this.ttsQueue = this.ttsQueue
      .then(async () => {
        if (abort.signal.aborted) {
          return;
        }
        let chunks = 0;
        // The webview reveals this text when the sentence's audio starts
        // playing, so the user never reads ahead of the voice. The same signal
        // drives synced side effects (tour highlights).
        let sentenceId: number | undefined;
        if (onAudioStart) {
          sentenceId = ++this.sentenceIdCounter;
          this.sentenceCallbacks.set(sentenceId, onAudioStart);
        }
        this.bridge.announceSentence(sentence, sentenceId, newBubble);
        await this.tts.speak(sentence, {
          model: config.ttsProvider === 'soniox' ? config.ttsSonioxModel : config.ttsModel,
          voice: config.ttsVoice,
          language,
          instructions: config.ttsInstructions,
          signal: abort.signal,
          onFirstByte: () => this.metrics?.mark('ttsFirstByte'),
          onChunk: (chunk) => {
            chunks++;
            this.audioIdle = false;
            this.bridge.playAudio(chunk);
          },
        });
        this.channel.appendLine(`[tts] "${sentence.slice(0, 50)}" → ${chunks} chunks sent to webview`);
      })
      .catch((err) => {
        if (!abort.signal.aborted) {
          this.channel.appendLine(`[tts error] ${String(err)}`);
        }
      });
  }

  private maybeFinishResponse(): void {
    if (this.streamingDone && this.audioIdle && (this.state === 'speaking' || this.state === 'thinking')) {
      this.setState('idle');
    }
  }

  dispose(): void {
    this.cancelResponse();
    this.mic.stop();
    this.stt.close();
  }
}
