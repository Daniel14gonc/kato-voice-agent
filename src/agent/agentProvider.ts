export interface AgentExploreRequest {
  prompt: string;
  /** Repo root the agent explores. */
  cwd: string;
  /** Additional workspace roots (multi-root workspaces) the agent may access. */
  extraDirs?: string[];
  /** Agent-side model override; empty = the CLI's configured default. */
  model?: string;
  signal: AbortSignal;
  /** Progress lines ("Read foo.ts", "Grep bar") for the Kato log. */
  onProgress?(line: string): void;
}

/**
 * Agent-agnostic delegation layer (M1: read-only exploration only; M3 extends
 * this to write tasks with permission levels). One adapter per coding agent —
 * Claude Code first, Codex later. Kato never marries a single agent.
 */
export interface AgentProvider {
  readonly name: string;
  /** Runs a read-only exploration and resolves with the agent's final text. */
  runReadOnly(request: AgentExploreRequest): Promise<string>;
}
