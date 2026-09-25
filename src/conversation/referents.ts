import * as vscode from 'vscode';

/**
 * A referent is something Kato mentioned that the user can point at by voice
 * ("ve al segundo", "explícame el R3"). Each gets a stable ID; the LLM router
 * only ever picks an ID — translating it to a URI+range is deterministic.
 */
export interface Referent {
  id: string;
  /** Short human label, e.g. "cards.ts:40 — renderCard()". */
  label: string;
  uri: vscode.Uri;
  range: vscode.Range;
  /** One-line code preview shown to the router for disambiguation. */
  preview?: string;
  /** How to say it aloud ("analyze, en llm") — labels are paths, which TTS mangles. */
  spoken?: string;
}

export class ReferentStore {
  private items: Referent[] = [];
  /** Index of the item the user is looking at, so "la otra" knows where to go next. */
  private currentIndex = -1;

  /**
   * Replaces the current referent list with the results of the latest command
   * (search hits, references, symbol matches). "El segundo" always means the
   * second item of the most recent list, which matches how people speak.
   */
  setResults(items: Array<Omit<Referent, 'id'>>, openedIndex = -1): Referent[] {
    this.items = items.map((item, i) => ({ ...item, id: `R${i + 1}` }));
    this.currentIndex = openedIndex;
    return this.items;
  }

  get(id: string): Referent | undefined {
    const normalized = id.trim().toUpperCase();
    return this.items.find((r) => r.id === normalized);
  }

  /** Marks a referent as the one on screen. */
  markCurrent(id: string): void {
    this.currentIndex = this.items.findIndex((r) => r.id === id.trim().toUpperCase());
  }

  /** "la otra" / "la siguiente": the next (or previous) item, wrapping around. */
  step(direction: 'next' | 'prev'): { ref: Referent; index: number; total: number } | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const delta = direction === 'next' ? 1 : -1;
    const start = this.currentIndex < 0 ? (direction === 'next' ? -1 : 0) : this.currentIndex;
    this.currentIndex = (start + delta + this.items.length) % this.items.length;
    return { ref: this.items[this.currentIndex], index: this.currentIndex, total: this.items.length };
  }

  all(): Referent[] {
    return this.items;
  }

  clear(): void {
    this.items = [];
  }

  /** Compact table for the router prompt; empty string when there is nothing. */
  toPromptTable(): string {
    if (this.items.length === 0) {
      return '';
    }
    return this.items
      .map(
        (r, i) =>
          `${r.id}: ${r.label}${r.preview ? ` — \`${r.preview}\`` : ''}${i === this.currentIndex ? '  ← on screen now' : ''}`,
      )
      .join('\n');
  }
}
