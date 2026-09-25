import WebSocket from 'ws';
import { releaseSocket } from './socketLifecycle';
import { promptWithVocabulary, type SttEvents, type SttProvider, type SttSessionOptions } from './sttProvider';

const REALTIME_BASE = 'wss://api.openai.com/v1/realtime';
const HANDSHAKE_TIMEOUT_MS = 4_000;

/**
 * Streaming transcription over the OpenAI Realtime API (GA transcription
 * session). Audio in: 24kHz mono PCM16 (base64). Endpointing is server-side
 * (VAD), which gives us the `speechEnd` latency mark for free.
 *
 * The GA docs are ambiguous about the connect URL for transcription sessions,
 * so connect() tries candidate URLs in order and settles on the first whose
 * session.update is acknowledged.
 */
export class OpenAIRealtimeStt implements SttProvider {
  /** Remembered across reconnects so we don't re-pay a failed candidate's timeout. */
  private static preferredUrl: string | undefined;

  private ws: WebSocket | undefined;
  private events: SttEvents | undefined;
  private partial = '';
  /** In-flight handshake, so a second connect() joins it instead of racing it
   * and orphaning the first socket. */
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
    if (this.connecting) {
      return this.connecting;
    }
    if (this.isConnected) {
      return;
    }
    // A leftover socket in CONNECTING or CLOSING is still a live session as far
    // as the provider is concerned; drop it properly, not just by reference.
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
      throw new Error('Missing OpenAI API key');
    }

    const candidates = [
      `${REALTIME_BASE}?intent=transcription`,
      `${REALTIME_BASE}?model=${encodeURIComponent(options.model)}`,
    ];
    if (OpenAIRealtimeStt.preferredUrl) {
      candidates.sort((a) => (a === OpenAIRealtimeStt.preferredUrl ? -1 : 1));
    }
    let lastError: Error | undefined;
    for (const url of candidates) {
      try {
        await this.tryConnect(url, apiKey, options);
        OpenAIRealtimeStt.preferredUrl = url;
        this.log(`[stt] connected via ${url}`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.log(`[stt] connect failed via ${url}: ${lastError.message}`);
        releaseSocket(this.ws);
        this.ws = undefined;
      }
    }
    throw lastError ?? new Error('Could not connect to the Realtime API');
  }

  /** Opens the socket, sends session.update, resolves once the server acks it. */
  private tryConnect(url: string, apiKey: string, options: SttSessionOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      this.ws = ws;
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(
        () => settle(new Error('Realtime API handshake timed out')),
        HANDSHAKE_TIMEOUT_MS,
      );
      timer.unref?.();
      // close() during the handshake has to fail this promise, or the awaiting
      // caller hangs on a socket that is already gone.
      this.abortHandshake = (err) => settle(err);

      ws.on('open', () => {
        const prompt = promptWithVocabulary(options);
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: 24000 },
                  transcription: {
                    model: options.model,
                    ...(options.language ? { language: options.language } : {}),
                    ...(prompt ? { prompt } : {}),
                  },
                  turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: options.silenceMs,
                  },
                  noise_reduction: { type: 'near_field' },
                },
              },
            },
          }),
        );
      });

      ws.on('message', (raw) => {
        const text = raw.toString();
        if (!settled) {
          // During handshake: wait for the session.update ack; any error event
          // fails this candidate URL so the next one can be tried.
          let msg: { type?: string; error?: { message?: string } };
          try {
            msg = JSON.parse(text);
          } catch {
            return;
          }
          if (msg.type === 'session.updated' || msg.type === 'transcription_session.updated') {
            settle();
          } else if (msg.type === 'error') {
            settle(new Error(msg.error?.message ?? 'Unknown Realtime API error'));
          }
          return;
        }
        this.handleMessage(text);
      });

      ws.on('error', (err) => {
        if (settled) {
          this.events?.onError(err instanceof Error ? err.message : String(err));
        } else {
          settle(err instanceof Error ? err : new Error(String(err)));
        }
      });

      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = undefined;
        }
        settle(new Error('Realtime API connection closed during handshake'));
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'input_audio_buffer.speech_started':
        this.partial = '';
        this.events?.onSpeechStarted();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.events?.onSpeechStopped();
        break;
      case 'conversation.item.input_audio_transcription.delta':
        this.partial += (msg.delta as string) ?? '';
        this.events?.onPartialTranscript(this.partial);
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = ((msg.transcript as string) ?? this.partial).trim();
        this.partial = '';
        if (transcript) {
          this.events?.onFinalTranscript(transcript);
        }
        break;
      }
      case 'error': {
        const error = msg.error as { message?: string } | undefined;
        this.events?.onError(error?.message ?? 'Unknown Realtime API error');
        break;
      }
    }
  }

  sendAudio(base64Pcm: string): void {
    if (this.isConnected) {
      this.ws!.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Pcm }));
    }
  }

  close(): void {
    const ws = this.ws;
    this.ws = undefined;
    this.abortHandshake?.(new Error('closed'));
    releaseSocket(ws);
  }
}
