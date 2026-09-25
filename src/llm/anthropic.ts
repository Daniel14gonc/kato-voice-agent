import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, StreamChatOptions } from './llmProvider';

export class AnthropicLlm implements LlmProvider {
  constructor(private readonly getApiKey: () => Promise<string | undefined>) {}

  async streamChat(options: StreamChatOptions): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Missing Anthropic API key (run "Kato: Set an API Key…")');
    }
    const client = new Anthropic({ apiKey });

    const system = options.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const messages = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const stream = client.messages.stream(
      {
        model: options.model,
        max_tokens: 512,
        ...(system ? { system } : {}),
        messages,
      },
      { signal: options.signal },
    );
    stream.on('text', (delta) => options.onDelta(delta));
    const final = await stream.finalMessage();
    return final.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
}
