export interface TtsSpeakOptions {
  model: string;
  voice: string;
  /** ISO language of the text (used by providers that want it, e.g. Soniox). */
  language?: string;
  instructions?: string;
  signal: AbortSignal;
  /** Called with the first audio byte of the whole spoken answer (latency mark). */
  onFirstByte?: () => void;
  /** Receives base64-encoded 24kHz mono PCM16 chunks, in order. */
  onChunk(base64Pcm: string): void;
}

/** Streaming text-to-speech. Implementations: OpenAI gpt-4o-mini-tts (v0.1). */
export interface TtsProvider {
  /** Streams one sentence/fragment. Resolves when the fragment finished streaming. */
  speak(text: string, options: TtsSpeakOptions): Promise<void>;
}
