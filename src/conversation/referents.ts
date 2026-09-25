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
}

export class ReferentStore {
  private items: Referent[] = [];

  /**
   * Replaces the current referent list with the results of the latest command
   * (search hits, references, symbol matches). "El segundo" always means the
   * second item of the most recent list, which matches how people speak.
   */
  setResults(items: Array<Omit<Referent, 'id'>>): Referent[] {
    this.items = items.map((item, i) => ({ ...item, id: `R${i + 1}` }));
    return this.items;
  }

  get(id: string): Referent | undefined {
    const normalized = id.trim().toUpperCase();
    return this.items.find((r) => r.id === normalized);
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
      .map((r) => `${r.id}: ${r.label}${r.preview ? ` — \`${r.preview}\`` : ''}`)
      .join('\n');
  }
}
