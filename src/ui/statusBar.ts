import * as vscode from 'vscode';
import type { AgentStatusUpdate } from '../agent/agentManager';
import type { PipelineState } from '../voice/audioBridge';

const LABELS: Record<PipelineState, string> = {
  idle: '$(mic) Kato',
  listening: '$(record) Kato: listening',
  thinking: '$(loading~spin) Kato: thinking',
  speaking: '$(unmute) Kato: speaking',
};

/** Once a finished task has been on screen this long, the agent item goes away. */
const DONE_LINGER_MS = 60_000;

export class KatoStatusBar {
  private readonly item: vscode.StatusBarItem;
  /**
   * The agent gets its own item. The voice item said "Kato" (idle) the whole
   * time a coding agent worked in the background, so from the status bar
   * nothing seemed to be happening.
   */
  private readonly agentItem: vscode.StatusBarItem;
  private agent: AgentStatusUpdate | undefined;
  private ticker: NodeJS.Timeout | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'kato.toggleTalk';
    this.item.tooltip = 'Kato: toggle talk (Ctrl+;)';
    this.update('idle');
    this.item.show();

    this.agentItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.agentItem.command = 'kato.showPanel';
  }

  update(state: PipelineState): void {
    this.item.text = LABELS[state];
  }

  updateAgent(update: AgentStatusUpdate): void {
    this.agent = update;
    this.renderAgent();
    const running = update.active && update.state !== 'ready' && update.state !== 'closed';
    if (running && !this.ticker) {
      // The elapsed time is the cheapest proof of life there is.
      this.ticker = setInterval(() => this.renderAgent(), 1000);
    } else if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    if (update.finishedAt !== undefined) {
      // Re-render once the linger window is over so the item hides itself.
      setTimeout(() => this.renderAgent(), DONE_LINGER_MS + 100).unref?.();
    }
  }

  private renderAgent(): void {
    const agent = this.agent;
    const finishedLongAgo = agent?.finishedAt !== undefined && Date.now() - agent.finishedAt > DONE_LINGER_MS;
    if (!agent || !agent.active || agent.state === 'closed' || finishedLongAgo) {
      this.agentItem.hide();
      return;
    }
    const elapsed = agent.startedAt ? clock(((agent.finishedAt ?? Date.now()) - agent.startedAt) / 1000) : '';
    const steps = agent.stepCount ? ` · ${agent.stepIndex ?? agent.stepCount}/${agent.stepCount}` : '';
    this.agentItem.backgroundColor = undefined;
    switch (agent.state) {
      case 'waiting_approval':
        this.agentItem.text = `$(bell-dot) ${agent.provider} needs your OK`;
        this.agentItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'ready':
        this.agentItem.text = `$(check) ${agent.provider} done · ${elapsed}`;
        break;
      case 'exploring':
        this.agentItem.text = `$(sync~spin) ${agent.provider} exploring · ${elapsed}`;
        break;
      default:
        this.agentItem.text = `$(sync~spin) ${agent.provider}${steps} · ${elapsed}`;
    }
    this.agentItem.tooltip = new vscode.MarkdownString(
      [
        `**${agent.provider}** — ${agent.modeLabel}`,
        agent.task ? `\n\n${agent.task.slice(0, 200)}` : '',
        agent.currentStep ? `\n\nNow: ${agent.currentStep}` : '',
        '\n\n_Click to open the Kato panel_',
      ].join(''),
    );
    this.agentItem.show();
  }

  dispose(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
    }
    this.item.dispose();
    this.agentItem.dispose();
  }
}

/** 83 → "1:23". */
function clock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
