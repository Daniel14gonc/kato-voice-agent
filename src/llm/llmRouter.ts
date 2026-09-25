import type { LlmProvider, StreamChatOptions } from './llmProvider';

/** Delegates each streamChat() call to the LLM provider selected in settings. */
export class LlmRouter implements LlmProvider {
  constructor(
    private readonly providers: Record<string, LlmProvider>,
    private readonly getSelected: () => string,
  ) {}

  async streamChat(options: StreamChatOptions): Promise<string> {
    const name = this.getSelected();
    const provider = this.providers[name];
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${name}`);
    }
    return provider.streamChat(options);
  }
}
