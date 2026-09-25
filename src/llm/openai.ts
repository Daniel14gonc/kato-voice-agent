import OpenAI from 'openai';
import type { LlmProvider, StreamChatOptions } from './llmProvider';

export function lowestReasoningEffort(model: string): { reasoning_effort: 'minimal' | 'none' } | Record<string, never> {
  if (!model.startsWith('gpt-5')) {
    return {};
  }
  // gpt-5, gpt-5-mini, gpt-5-nano… (no dot version) vs gpt-5.1+, gpt-5.6-luna…
  return /^gpt-5(-|$)/.test(model) ? { reasoning_effort: 'minimal' } : { reasoning_effort: 'none' };
}

export class OpenAILlm implements LlmProvider {
  constructor(private readonly getApiKey: () => Promise<string | undefined>) {}

  private async client(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Missing OpenAI API key');
    }
    return new OpenAI({ apiKey });
  }

  async streamChat(options: StreamChatOptions): Promise<string> {
    const client = await this.client();
    const stream = await client.chat.completions.create(
      {
        model: options.model,
        messages: options.messages,
        stream: true,
        // gpt-5 family are reasoning models; the lowest effort keeps TTFT low
        // enough for the voice loop. The 5.0 family calls that 'minimal';
        // 5.1+ (incl. 5.6 Luna/Terra/Sol) renamed it 'none' and reject
        // 'minimal'. Other models reject the parameter entirely.
        ...lowestReasoningEffort(options.model),
      },
      { signal: options.signal },
    );
    let full = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        full += delta;
        options.onDelta(delta);
      }
    }
    return full;
  }
}
