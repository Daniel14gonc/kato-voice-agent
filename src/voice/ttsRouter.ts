import type { TtsProvider, TtsSpeakOptions } from './ttsProvider';

/** Delegates each speak() call to the TTS provider selected in settings. */
export class TtsRouter implements TtsProvider {
  constructor(
    private readonly providers: Record<string, TtsProvider>,
    private readonly getSelected: () => string,
  ) {}

  async speak(text: string, options: TtsSpeakOptions): Promise<void> {
    const name = this.getSelected();
    const provider = this.providers[name];
    if (!provider) {
      throw new Error(`Unknown TTS provider: ${name}`);
    }
    return provider.speak(text, options);
  }
}
