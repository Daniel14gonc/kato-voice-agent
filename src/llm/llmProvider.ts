export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta(text: string): void;
}

/**
 * Kato's internal LLM (router + voice layer). OpenAI in v0.1; the interface
 * exists so other providers (Anthropic, …) can be added without touching
 * callers.
 */
export interface LlmProvider {
  /** Streams a chat completion; resolves with the full text when done. */
  streamChat(options: StreamChatOptions): Promise<string>;
}
