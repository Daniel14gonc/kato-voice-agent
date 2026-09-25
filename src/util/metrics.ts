import * as vscode from 'vscode';

export type MetricMark =
  | 'speechEnd'
  | 'transcriptFinal'
  | 'llmFirstToken'
  | 'ttsFirstByte'
  | 'audioFirstPlay';

/**
 * Per-utterance latency instrumentation. Every stage of the voice loop records
 * a mark; when audio starts playing we log the full breakdown. This stays in
 * the product permanently (plan M0 requirement).
 */
export class UtteranceMetrics {
  private static counter = 0;
  readonly id: number;
  private readonly marks = new Map<MetricMark, number>();

  constructor(private readonly channel: vscode.OutputChannel) {
    this.id = ++UtteranceMetrics.counter;
  }

  mark(name: MetricMark): void {
    if (!this.marks.has(name)) {
      this.marks.set(name, Date.now());
    }
  }

  has(name: MetricMark): boolean {
    return this.marks.has(name);
  }

  private delta(from: MetricMark, to: MetricMark): string {
    const a = this.marks.get(from);
    const b = this.marks.get(to);
    if (a === undefined || b === undefined) {
      return 'n/a';
    }
    return `${b - a}ms`;
  }

  report(): void {
    this.channel.appendLine(
      `[latency #${this.id}] ` +
        `speechEnd→transcript: ${this.delta('speechEnd', 'transcriptFinal')} | ` +
        `transcript→llmFirstToken: ${this.delta('transcriptFinal', 'llmFirstToken')} | ` +
        `llmFirstToken→ttsFirstByte: ${this.delta('llmFirstToken', 'ttsFirstByte')} | ` +
        `ttsFirstByte→audible: ${this.delta('ttsFirstByte', 'audioFirstPlay')} | ` +
        `TOTAL speechEnd→audible: ${this.delta('speechEnd', 'audioFirstPlay')}`,
    );
  }
}
