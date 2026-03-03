import { describe, it, expect, beforeEach } from "vitest";
import { SessionState } from "../session.js";

describe("SessionState", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState();
  });

  it("starts empty", () => {
    const summary = session.getSummary();
    expect(summary.totalActions).toBe(0);
    expect(summary.queriedEntities).toEqual([]);
    expect(summary.decisions).toEqual([]);
    expect(summary.ingestedPaths).toEqual([]);
    expect(summary.intents).toEqual([]);
    expect(summary.recentActions).toEqual([]);
  });

  it("tracks queries", () => {
    session.track({ type: "query", summary: "How does billing work?", timestamp: "2025-01-01T00:00:00Z" });
    const summary = session.getSummary();
    expect(summary.totalActions).toBe(1);
    expect(summary.recentActions).toHaveLength(1);
    expect(summary.recentActions[0].type).toBe("query");
    expect(summary.recentActions[0].summary).toBe("How does billing work?");
  });

  it("tracks entity IDs without duplicates", () => {
    session.trackEntities(["id-1", "id-2", "id-1"]);
    const summary = session.getSummary();
    expect(summary.queriedEntities).toHaveLength(2);
    expect(summary.queriedEntities).toContain("id-1");
    expect(summary.queriedEntities).toContain("id-2");
  });

  it("tracks decisions", () => {
    session.track({ type: "decision", id: "dec-1", summary: "Use REST over GraphQL", timestamp: "2025-01-01T00:00:00Z" });
    const summary = session.getSummary();
    expect(summary.decisions).toContain("Use REST over GraphQL");
    expect(summary.totalActions).toBe(1);
  });

  it("tracks ingested paths", () => {
    session.track({ type: "ingest", summary: "src/main.ts", timestamp: "2025-01-01T00:00:00Z" });
    const summary = session.getSummary();
    expect(summary.ingestedPaths).toContain("src/main.ts");
  });

  it("tracks intents from truth entries", () => {
    session.track({ type: "truth", summary: "Build a fast API", timestamp: "2025-01-01T00:00:00Z" });
    const summary = session.getSummary();
    expect(summary.intents).toContain("Build a fast API");
  });

  it("does not cross-populate categories", () => {
    session.track({ type: "query", summary: "test query", timestamp: "2025-01-01T00:00:00Z" });
    session.track({ type: "entity", id: "e-1", summary: "Looked up entity e-1", timestamp: "2025-01-01T00:00:00Z" });
    session.track({ type: "conflict", summary: "Checked conflicts", timestamp: "2025-01-01T00:00:00Z" });
    const summary = session.getSummary();
    expect(summary.decisions).toEqual([]);
    expect(summary.ingestedPaths).toEqual([]);
    expect(summary.intents).toEqual([]);
    expect(summary.totalActions).toBe(3);
  });

  it("limits recent actions to 10", () => {
    for (let i = 0; i < 15; i++) {
      session.track({ type: "query", summary: `q${i}`, timestamp: "2025-01-01T00:00:00Z" });
    }
    const summary = session.getSummary();
    expect(summary.totalActions).toBe(15);
    expect(summary.recentActions).toHaveLength(10);
    // Should be the most recent 10 (q5 through q14)
    expect(summary.recentActions[0].summary).toBe("q5");
    expect(summary.recentActions[9].summary).toBe("q14");
  });

  it("clears state", () => {
    session.track({ type: "query", summary: "test", timestamp: "2025-01-01T00:00:00Z" });
    session.track({ type: "decision", id: "d-1", summary: "picked X", timestamp: "2025-01-01T00:00:00Z" });
    session.track({ type: "ingest", summary: "file.ts", timestamp: "2025-01-01T00:00:00Z" });
    session.track({ type: "truth", summary: "goal A", timestamp: "2025-01-01T00:00:00Z" });
    session.trackEntities(["id-1"]);
    session.clear();
    const summary = session.getSummary();
    expect(summary.totalActions).toBe(0);
    expect(summary.queriedEntities).toEqual([]);
    expect(summary.decisions).toEqual([]);
    expect(summary.ingestedPaths).toEqual([]);
    expect(summary.intents).toEqual([]);
    expect(summary.recentActions).toEqual([]);
  });

  it("accumulates multiple entries of the same type", () => {
    session.track({ type: "ingest", summary: "a.ts", timestamp: "2025-01-01T00:00:00Z" });
    session.track({ type: "ingest", summary: "b.ts", timestamp: "2025-01-01T00:00:00Z" });
    session.track({ type: "decision", id: "d-1", summary: "use X", timestamp: "2025-01-01T00:00:00Z" });
    session.track({ type: "decision", id: "d-2", summary: "use Y", timestamp: "2025-01-01T00:00:00Z" });
    const summary = session.getSummary();
    expect(summary.ingestedPaths).toEqual(["a.ts", "b.ts"]);
    expect(summary.decisions).toEqual(["use X", "use Y"]);
    expect(summary.totalActions).toBe(4);
  });

  it("trackEntities accumulates across multiple calls", () => {
    session.trackEntities(["id-1", "id-2"]);
    session.trackEntities(["id-3", "id-1"]);
    const summary = session.getSummary();
    expect(summary.queriedEntities).toHaveLength(3);
    expect(summary.queriedEntities).toContain("id-1");
    expect(summary.queriedEntities).toContain("id-2");
    expect(summary.queriedEntities).toContain("id-3");
  });
});
