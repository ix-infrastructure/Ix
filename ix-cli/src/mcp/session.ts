/**
 * Session State — in-memory working set tracking for the MCP server.
 *
 * Accumulates a record of tool invocations within a single session so that
 * ix://session/context can return a rich summary of what the LLM has
 * queried, decided, ingested, and recorded during the current session.
 *
 * Pure in-memory — the session resets when the MCP server process restarts.
 */

export interface SessionEntry {
  type: "query" | "entity" | "decision" | "ingest" | "conflict" | "truth";
  id?: string; // entity ID, decision ID, etc.
  summary: string; // short description
  timestamp: string; // ISO timestamp
}

export interface SessionSummary {
  totalActions: number;
  queriedEntities: string[]; // unique entity IDs
  decisions: string[]; // decision titles
  ingestedPaths: string[]; // file paths ingested
  intents: string[]; // recorded intent statements
  recentActions: SessionEntry[]; // last 10 entries
}

export class SessionState {
  private entries: SessionEntry[] = [];
  private queriedEntityIds: Set<string> = new Set();
  private decidedTitles: string[] = [];
  private ingestedPaths: string[] = [];
  private recordedIntents: string[] = [];

  /** Record a tool invocation */
  track(entry: SessionEntry): void {
    this.entries.push(entry);

    switch (entry.type) {
      case "decision":
        this.decidedTitles.push(entry.summary);
        break;
      case "ingest":
        this.ingestedPaths.push(entry.summary);
        break;
      case "truth":
        this.recordedIntents.push(entry.summary);
        break;
    }
  }

  /** Record entity IDs seen in a query result */
  trackEntities(ids: string[]): void {
    for (const id of ids) {
      this.queriedEntityIds.add(id);
    }
  }

  /** Get the current working set summary (for ix://session/context) */
  getSummary(): SessionSummary {
    return {
      totalActions: this.entries.length,
      queriedEntities: [...this.queriedEntityIds],
      decisions: [...this.decidedTitles],
      ingestedPaths: [...this.ingestedPaths],
      intents: [...this.recordedIntents],
      recentActions: this.entries.slice(-10),
    };
  }

  /** Clear session (for testing) */
  clear(): void {
    this.entries = [];
    this.queriedEntityIds = new Set();
    this.decidedTitles = [];
    this.ingestedPaths = [];
    this.recordedIntents = [];
  }
}
