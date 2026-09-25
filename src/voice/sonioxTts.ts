import type { TtsProvider, TtsSpeakOptions } from './ttsProvider';

const SONIOX_TTS_URL = 'https://tts-rt.soniox.com/tts';

/**
 * Soniox TTS over REST (per-sentence requests; the response body streams raw
 * PCM bytes as they are generated). 24kHz mono PCM16 to match the playback
 * path.
 */
export class SonioxTts implements TtsProvider {
  constructor(private readonly getApiKey: () => Promise<string | undefined>) {}

  async speak(text: string, options: TtsSpeakOptions): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Missing Soniox API key (run "Kato: Set an API Key…")');
    }
    const response = await fetch(SONIOX_TTS_URL, {
      method: 'POST',
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model: options.model,
        voice: options.voice,
        // Soniox requires language; default to English when detection is absent
        // (spontaneous notifications don't come from a transcribed utterance).
        language: options.language ?? 'en',
        audio_format: 'pcm_s16le',
        sample_rate: 24000,
      }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Soniox TTS failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
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
