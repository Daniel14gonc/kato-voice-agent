import type { TtsProvider, TtsSpeakOptions } from './ttsProvider';

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

/**
 * Streaming TTS via OpenAI. `response_format: 'pcm'` returns raw 24kHz mono
 * PCM16, which the webview can schedule directly without decoding.
 */
export class OpenAITts implements TtsProvider {
  constructor(private readonly getApiKey: () => Promise<string | undefined>) {}

  async speak(text: string, options: TtsSpeakOptions): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Missing OpenAI API key');
    }
    const response = await fetch(SPEECH_URL, {
      method: 'POST',
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        voice: options.voice,
        input: text,
        response_format: 'pcm',
        // Only gpt-4o TTS models accept style instructions.
        ...(options.instructions && options.model.startsWith('gpt-4o')
          ? { instructions: options.instructions }
          : {}),
      }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`TTS request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    // PCM16 frames are 2 bytes; a chunk split mid-sample corrupts playback,
    // so carry the odd byte over to the next chunk.
    let carry: Uint8Array | undefined;
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (first) {
        first = false;
        options.onFirstByte?.();
      }
      let bytes = value;
      if (carry) {
        const merged = new Uint8Array(carry.length + bytes.length);
        merged.set(carry);
        merged.set(bytes, carry.length);
        bytes = merged;
        carry = undefined;
      }
      if (bytes.length % 2 === 1) {
        carry = bytes.slice(bytes.length - 1);
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (bytes.length > 0) {
        options.onChunk(Buffer.from(bytes).toString('base64'));
      }
    }
  }
}
