import * as vscode from 'vscode';
import type { PipelineState } from '../voice/audioBridge';

const LABELS: Record<PipelineState, string> = {
  idle: '$(mic) Kato',
  listening: '$(record) Kato: listening',
  thinking: '$(loading~spin) Kato: thinking',
  speaking: '$(unmute) Kato: speaking',
};

export class KatoStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'kato.toggleTalk';
    this.item.tooltip = 'Kato: toggle talk (Ctrl+;)';
    this.update('idle');
    this.item.show();
  }

  update(state: PipelineState): void {
    this.item.text = LABELS[state];
  }

  dispose(): void {
    this.item.dispose();
  }
}
