import type { SttEvents, SttProvider, SttSessionOptions } from './sttProvider';

/**
 * Delegates to the STT provider currently selected in settings, so switching
 * kato.stt.provider takes effect on the next utterance without a reload.
 */
export class SttRouter implements SttProvider {
  private active: SttProvider | undefined;

  constructor(
    private readonly providers: Record<string, SttProvider>,
    private readonly getSelected: () => string,
  ) {}

  get isConnected(): boolean {
    return this.active?.isConnected ?? false;
  }

  async connect(options: SttSessionOptions, events: SttEvents): Promise<void> {
    const name = this.getSelected();
    const next = this.providers[name];
    if (!next) {
      throw new Error(`Unknown STT provider: ${name}`);
    }
    if (this.active && this.active !== next) {
      this.active.close();
    }
    this.active = next;
    await next.connect(options, events);
  }

  sendAudio(base64Pcm: string): void {
    this.active?.sendAudio(base64Pcm);
  }

  close(): void {
    this.active?.close();
    this.active = undefined;
  }
}
