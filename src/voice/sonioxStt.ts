import WebSocket from 'ws';
import { releaseSocket } from './socketLifecycle';
import { promptWithVocabulary, type SttEvents, type SttProvider, type SttSessionOptions } from './sttProvider';

const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Special Soniox tokens marking utterance/finalization boundaries. */
const BOUNDARY_TOKENS = new Set(['<end>', '<fin>']);

interface SonioxToken {
  text: string;
  is_final: boolean;
  language?: string;
}

interface SonioxMessage {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

/**
 * Streaming transcription via Soniox (stt-rt). Strong at es/en code-switching.
 * Audio in: binary frames of 24kHz mono PCM16. Endpoint detection emits an
 * <end> token, which we map to speechStopped + finalTranscript.
 */
export class SonioxStt implements SttProvider {
  private ws: WebSocket | undefined;
  private events: SttEvents | undefined;
  private finalText = '';
  private speechStartedReported = false;
  private languageCounts = new Map<string, number>();
  private endpointTimer: NodeJS.Timeout | undefined;
  private graceMs = 500;
  /** In-flight handshake, so a second connect() joins it instead of opening a
   * second session (each orphan kept burning a concurrency slot). */
  private connecting: Promise<void> | undefined;
  /** Fails the in-flight handshake when the session is torn down mid-connect. */
  private abortHandshake: ((err: Error) => void) | undefined;

  constructor(
    private readonly getApiKey: () => Promise<string | undefined>,
    private readonly log: (message: string) => void = () => {},
  ) {}

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(options: SttSessionOptions, events: SttEvents): Promise<void> {
    this.events = events;
    this.finalText = '';
    this.speechStartedReported = false;
    this.languageCounts.clear();
    this.graceMs = options.silenceMs ?? 500;
    this.clearEndpointTimer();
    // Ctrl+; twice during a slow start-up used to run two full connects and
    // leak the first socket, one concurrency slot at a time.
    if (this.connecting) {
      return this.connecting;
    }
    if (this.isConnected) {
      return;
    }
    // Anything left over — still CONNECTING, or CLOSING while the server takes
    // its time — is a live session until it is actually released.
    releaseSocket(this.ws);
    this.ws = undefined;
    this.connecting = this.openSocket(options).finally(() => {
      this.connecting = undefined;
      this.abortHandshake = undefined;
    });
    return this.connecting;
  }

  private async openSocket(options: SttSessionOptions): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Missing Soniox API key (run "Kato: Configure API Keys")');
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(SONIOX_URL);
      this.ws = ws;
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.abortHandshake = undefined;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      // A handshake that never completes would leave the pipeline stuck in
      // start-up forever, with no way to press the key again.
      const timeout = setTimeout(() => {
        releaseSocket(ws);
        if (this.ws === ws) {
          this.ws = undefined;
        }
        settle(new Error('Soniox no respondió al handshake'));
      }, HANDSHAKE_TIMEOUT_MS);
      timeout.unref?.();
      // close() during the handshake has to fail this promise, or the awaiting
      // caller hangs on a socket that no longer exists.
      this.abortHandshake = (err) => settle(err);

      ws.on('open', () => {
        const prompt = promptWithVocabulary(options);
        ws.send(
          JSON.stringify({
            api_key: apiKey,
            model: options.model,
            audio_format: 's16le',
            sample_rate: 24000,
            num_channels: 1,
            language_hints: options.language ? [options.language] : ['es', 'en'],
            enable_language_identification: true,
            enable_endpoint_detection: true,
            ...(prompt ? { context: { text: prompt } } : {}),
          }),
        );
        this.log('[stt] soniox connected');
        settle();
      });

      ws.on('message', (raw) => this.handleMessage(raw.toString()));

      ws.on('error', (err) => {
        if (settled) {
          this.events?.onError(err.message);
        } else {
          settle(err);
        }
      });

      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = undefined;
        }
        settle(new Error('Soniox connection closed during handshake'));
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: SonioxMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.error_code) {
      this.events?.onError(describeError(msg.error_code, msg.error_message));
      return;
    }
    if (msg.finished) {
      // The server finished with this session and will hang up; release the
      // socket now rather than leaving it to the force-close timer.
      releaseSocket(this.ws);
      this.ws = undefined;
      return;
    }
    if (!msg.tokens) {
      return;
    }

    let endpointReached = false;
    let nonFinalText = '';
    let sawContent = false;
    for (const token of msg.tokens) {
      if (BOUNDARY_TOKENS.has(token.text.trim())) {
        endpointReached = true;
        continue;
      }
      if (token.text.trim()) {
        sawContent = true;
      }
      if (token.is_final) {
        this.finalText += token.text;
        if (token.language) {
          this.languageCounts.set(token.language, (this.languageCounts.get(token.language) ?? 0) + 1);
        }
      } else {
        nonFinalText += token.text;
      }
    }

    // The speaker resumed after a pause Soniox took for an endpoint: cancel
    // the pending finalization and keep accumulating the same utterance.
    if (sawContent && this.endpointTimer) {
      this.clearEndpointTimer();
    }

    const partial = (this.finalText + nonFinalText).trim();
    if (partial && !this.speechStartedReported) {
      this.speechStartedReported = true;
      this.events?.onSpeechStarted();
    }
    if (partial) {
      this.events?.onPartialTranscript(partial);
    }

    if (endpointReached && this.finalText.trim() && !this.endpointTimer) {
      // Grace window: mid-sentence thinking pauses shouldn't cut the user off.
      // Only sustained silence finalizes the utterance.
      this.endpointTimer = setTimeout(() => this.finalizeUtterance(), this.graceMs);
    }
  }

  private finalizeUtterance(): void {
    this.clearEndpointTimer();
    const transcript = this.finalText.trim();
    let dominantLanguage: string | undefined;
    let best = 0;
    for (const [lang, count] of this.languageCounts) {
      if (count > best) {
        best = count;
        dominantLanguage = lang;
      }
    }
    this.finalText = '';
    this.speechStartedReported = false;
    this.languageCounts.clear();
    if (transcript) {
      this.events?.onSpeechStopped();
      this.events?.onFinalTranscript(transcript, dominantLanguage);
    }
  }

  private clearEndpointTimer(): void {
    if (this.endpointTimer) {
      clearTimeout(this.endpointTimer);
      this.endpointTimer = undefined;
    }
  }

  sendAudio(base64Pcm: string): void {
    if (this.isConnected) {
      this.ws!.send(Buffer.from(base64Pcm, 'base64'));
    }
  }

  close(): void {
    this.clearEndpointTimer();
    const ws = this.ws;
    this.ws = undefined;
    this.abortHandshake?.(new Error('closed'));
    // Empty frame asks Soniox to finalize and release the session server-side.
    releaseSocket(ws, { farewell: (socket) => socket.send(Buffer.alloc(0)) });
  }
}

function describeError(code: number, message?: string): string {
  if (code === 429) {
    return (
      'Soniox 429: se superó el límite de transcripciones en tiempo real simultáneas de tu organización. ' +
      'Si no hay otra app usándolo, son sesiones de Kato que quedaron colgadas: recarga la ventana ' +
      '(Developer: Reload Window) y vuelve a intentarlo, o cambia kato.stt.provider a openai mientras tanto.'
    );
  }
  if (code === 401 || code === 403) {
    return `Soniox ${code}: la API key no es válida. Vuelve a configurarla con "Kato: Configure API Keys".`;
  }
  return `Soniox ${code}: ${message ?? 'unknown error'}`;
}
