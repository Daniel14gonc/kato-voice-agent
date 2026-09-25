import WebSocket from 'ws';
import { releaseSocket } from './socketLifecycle';
import type { SttEvents, SttProvider, SttSessionOptions } from './sttProvider';

// Edge endpoint: auto-routes to the nearest region (Ireland from Spain).
const ASSEMBLYAI_URL = 'wss://streaming.assemblyai.com/v3/ws';

const HANDSHAKE_TIMEOUT_MS = 10_000;

const SAMPLE_RATE = 24_000;

/** The API rejects chunks under 50ms (close code 3007); ffmpeg's data events
 * can be smaller, so audio is coalesced to at least this many bytes. */
const MIN_CHUNK_BYTES = (SAMPLE_RATE / 20) * 2; // 50ms of mono PCM16

/** U3.5 Pro caps: prompt length and keyterm count. */
const MAX_PROMPT_CHARS = 1_750;
const MAX_KEYTERMS = 100;

interface AssemblyAiMessage {
  type?: string;
  // Turn
  transcript?: string;
  utterance?: string;
  end_of_turn?: boolean;
  language_code?: string;
  // Error frames
  error?: string;
}

/**
 * Streaming transcription via AssemblyAI (Universal-3.5 Pro). Native es/en
 * code-switching, so no bias prompt gymnastics needed. Audio in: binary frames
 * of 24kHz mono PCM16. End-of-turn Turn events map to speechStopped +
 * finalTranscript, mirroring the Soniox <end>-token mapping.
 */
export class AssemblyAiStt implements SttProvider {
  private ws: WebSocket | undefined;
  private events: SttEvents | undefined;
  private speechStartedReported = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** In-flight handshake, so a second connect() joins it instead of opening a
   * second session. */
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
    this.speechStartedReported = false;
    this.pending = [];
    this.pendingBytes = 0;
    if (this.connecting) {
      return this.connecting;
    }
    if (this.isConnected) {
      return;
    }
    releaseSocket(this.ws);
    this.ws = undefined;
    this.connecting = this.openSocket(options).finally(() => {
      this.connecting = undefined;
      this.abortHandshake = undefined;
    });
    return this.connecting;
  }

  private buildUrl(options: SttSessionOptions): string {
    const url = new URL(ASSEMBLYAI_URL);
    const params = url.searchParams;
    params.set('speech_model', options.model || 'universal-3-5-pro');
    params.set('sample_rate', String(SAMPLE_RATE));
    params.set('encoding', 'pcm_s16le');
    params.set('mode', 'min_latency');
    // Array-valued params travel as JSON-encoded strings (per the AsyncAPI spec).
    params.set(
      'language_codes',
      JSON.stringify(options.language ? [options.language] : ['es', 'en']),
    );
    params.set('language_detection', 'true');
    params.set('min_turn_silence', String(options.silenceMs));
    params.set('voice_focus', 'near-field');
    if (options.prompt) {
      params.set('prompt', options.prompt.slice(0, MAX_PROMPT_CHARS));
    }
    const keyterms = (options.vocabulary ?? []).slice(0, MAX_KEYTERMS);
    if (keyterms.length) {
      params.set('keyterms_prompt', JSON.stringify(keyterms));
    }
    return url.toString();
  }

  private async openSocket(options: SttSessionOptions): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Missing AssemblyAI API key (run "Kato: Set an API Key…")');
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.buildUrl(options), {
        headers: { Authorization: apiKey },
      });
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
      const timeout = setTimeout(() => {
        releaseSocket(ws);
        if (this.ws === ws) {
          this.ws = undefined;
        }
        settle(new Error('AssemblyAI did not answer the handshake'));
      }, HANDSHAKE_TIMEOUT_MS);
      timeout.unref?.();
      this.abortHandshake = (err) => settle(err);

      ws.on('open', () => {
        this.log('[stt] assemblyai connected');
        settle();
      });

      // A rejected upgrade (401 = bad key) never reaches 'open'.
      ws.on('unexpected-response', (_req, res) => {
        const detail =
          res.statusCode === 401
            ? 'the API key is invalid. Set it again with "Kato: Set an API Key…".'
            : `HTTP ${res.statusCode}`;
        settle(new Error(`AssemblyAI: ${detail}`));
      });

      ws.on('message', (raw) => this.handleMessage(raw.toString()));

      ws.on('error', (err) => {
        if (settled) {
          this.events?.onError(`AssemblyAI: ${err.message}`);
        } else {
          settle(err);
        }
      });

      ws.on('close', (code, reason) => {
        if (this.ws === ws) {
          this.ws = undefined;
        }
        if (!settled) {
          settle(new Error('AssemblyAI connection closed during handshake'));
        } else if (code !== 1000 && code !== 1005) {
          this.events?.onError(describeClose(code, reason.toString()));
        }
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: AssemblyAiMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'SpeechStarted':
        if (!this.speechStartedReported) {
          this.speechStartedReported = true;
          this.events?.onSpeechStarted();
        }
        return;
      case 'Turn': {
        const transcript = (msg.transcript ?? '').trim();
        if (msg.end_of_turn) {
          const finalText = (msg.utterance ?? '').trim() || transcript;
          this.speechStartedReported = false;
          if (finalText) {
            this.events?.onSpeechStopped();
            this.events?.onFinalTranscript(finalText, msg.language_code);
          }
        } else if (transcript) {
          this.events?.onPartialTranscript(transcript);
        }
        return;
      }
      case 'Termination':
        // The server is done with this session and will hang up; release the
        // socket now rather than leaving it to the force-close timer.
        releaseSocket(this.ws);
        this.ws = undefined;
        return;
      default:
        if (msg.error) {
          this.events?.onError(`AssemblyAI: ${msg.error}`);
        }
    }
  }

  sendAudio(base64Pcm: string): void {
    if (!this.isConnected) {
      return;
    }
    const chunk = Buffer.from(base64Pcm, 'base64');
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= MIN_CHUNK_BYTES) {
      this.ws!.send(Buffer.concat(this.pending));
      this.pending = [];
      this.pendingBytes = 0;
    }
  }

  close(): void {
    this.pending = [];
    this.pendingBytes = 0;
    const ws = this.ws;
    this.ws = undefined;
    this.abortHandshake?.(new Error('closed'));
    // An unterminated session keeps billing until the 3-hour server cap.
    releaseSocket(ws, { farewell: (socket) => socket.send(JSON.stringify({ type: 'Terminate' })) });
  }
}

function describeClose(code: number, reason: string): string {
  switch (code) {
    case 1008:
      return 'AssemblyAI 1008: unauthorized. Check the API key with "Kato: Set an API Key…".';
    case 3005:
      return 'AssemblyAI 3005: the session was cancelled by a server error. Try again.';
    case 3007:
      return 'AssemblyAI 3007: audio chunk outside 50–1000ms or sent faster than real time.';
    default:
      return `AssemblyAI closed the connection (${code}): ${reason || 'no detail'}`;
  }
}
