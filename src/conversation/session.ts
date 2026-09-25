import type { ChatMessage } from '../llm/llmProvider';

const MAX_TURNS = 12; // ~6 user/assistant exchanges

/**
 * Multi-turn conversation memory. Both the router and the explainer see this
 * history, so follow-ups ("can you suggest one?") keep their context instead
 * of being answered in a vacuum.
 */
export class ConversationSession {
  private turns: ChatMessage[] = [];

  addUser(content: string): void {
    this.push({ role: 'user', content });
  }

  addAssistant(content: string): void {
    if (content.trim()) {
      this.push({ role: 'assistant', content });
    }
  }

  history(): ChatMessage[] {
    return [...this.turns];
  }

  clear(): void {
    this.turns = [];
  }

  private push(message: ChatMessage): void {
    this.turns.push(message);
    if (this.turns.length > MAX_TURNS) {
      this.turns = this.turns.slice(-MAX_TURNS);
    }
  }
}
