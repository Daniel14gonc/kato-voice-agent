/**
 * Splits an LLM token stream into sentences so TTS can start speaking the
 * first sentence while the rest is still generating.
 */
export class SentenceStream {
  private buffer = '';
  private emitted = 0;

  constructor(
    /** `index` is the 0-based position of this sentence in the stream. */
    private readonly onSentence: (sentence: string, index: number) => void,
    private readonly minLength = 12,
  ) {}

  push(delta: string): void {
    this.buffer += delta;
    for (;;) {
      const match = this.buffer.match(/^[\s\S]*?[.!?…](?=\s|$)|^[\s\S]*?\n/);
      if (!match) {
        return;
      }
      const candidate = match[0];
      if (candidate.trim().length < this.minLength && candidate.length < this.buffer.length) {
        // Too short to be worth a TTS round-trip (e.g. "Ok."); wait for more
        // text unless nothing else is coming.
        const rest = this.buffer.slice(candidate.length);
        if (rest.trim().length === 0) {
          return;
        }
      }
      this.buffer = this.buffer.slice(candidate.length);
      const sentence = candidate.trim();
      if (sentence) {
        this.onSentence(sentence, this.emitted++);
      }
    }
  }

  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) {
      this.onSentence(rest, this.emitted++);
    }
  }
}
