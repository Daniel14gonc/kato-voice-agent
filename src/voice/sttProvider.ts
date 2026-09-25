export interface SttEvents {
  onSpeechStarted(): void;
  /** Server VAD detected end of speech — latency mark `speechEnd`. */
  onSpeechStopped(): void;
  onPartialTranscript(text: string): void;
  /** @param language dominant ISO language of the utterance, if the provider detects it. */
  onFinalTranscript(text: string, language?: string): void;
  onError(message: string): void;
}

export interface SttSessionOptions {
  model: string;
  /** ISO language hint, empty for auto-detect. */
  language: string;
  /** Server VAD silence duration before end-of-turn. */
  silenceMs: number;
  /** Natural-language description of the audio to bias transcription. */
  prompt?: string;
  /** Exact terms (symbol/file names on screen) the speaker may say. */
  vocabulary?: string[];
}

/**
 * Prompt with the vocabulary folded in, for providers without a structured
 * key-terms field (AssemblyAI takes `vocabulary` separately as keyterms).
 */
export function promptWithVocabulary(options: SttSessionOptions): string | undefined {
  const vocabulary = options.vocabulary ?? [];
  if (!vocabulary.length) {
    return options.prompt;
  }
  const list = `Identifiers the speaker may say: ${vocabulary.join(', ')}.`;
  return options.prompt ? `${options.prompt}\n${list}` : list;
}

/** Streaming speech-to-text. Implementations: OpenAI Realtime (v0.1). */
export interface SttProvider {
  connect(options: SttSessionOptions, events: SttEvents): Promise<void>;
  sendAudio(base64Pcm: string): void;
  readonly isConnected: boolean;
  close(): void;
}
