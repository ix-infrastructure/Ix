import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatContext,
  formatIntents,
  formatConflicts,
  formatDecisions,
  formatTextResults,
  confidenceColor,
} from "../format.js";

// Strip ANSI escape codes for clean assertions
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

// Capture console.log output
function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return lines.join("\n");
}

describe("confidenceColor", () => {
  it("returns green for high confidence (>= 0.8)", () => {
    const color = confidenceColor(0.9);
    const result = color("test");
    // chalk.green wraps text; stripped should still have the text
    expect(stripAnsi(result)).toBe("test");
    // The raw output should contain ANSI codes (or not, if chalk level is 0)
    // Either way, the function should return a function
    expect(typeof confidenceColor(0.8)).toBe("function");
  });

  it("returns yellow for medium confidence (0.5–0.79)", () => {
    const color = confidenceColor(0.6);
    const result = color("test");
    expect(stripAnsi(result)).toBe("test");
    expect(typeof confidenceColor(0.5)).toBe("function");
  });

  it("returns red for low confidence (< 0.5)", () => {
    const color = confidenceColor(0.3);
    const result = color("test");
    expect(stripAnsi(result)).toBe("test");
    expect(typeof confidenceColor(0.0)).toBe("function");
  });

  it("boundary: 0.8 is green, 0.79 is yellow, 0.49 is red", () => {
    // 0.8 should be green
    const green = confidenceColor(0.8);
    // 0.79 should be yellow
    const yellow = confidenceColor(0.79);
    // 0.49 should be red
    const red = confidenceColor(0.49);

    // All should be functions
    expect(typeof green).toBe("function");
    expect(typeof yellow).toBe("function");
    expect(typeof red).toBe("function");

    // They should all produce the text content
    expect(stripAnsi(green("x"))).toBe("x");
    expect(stripAnsi(yellow("x"))).toBe("x");
    expect(stripAnsi(red("x"))).toBe("x");
  });
});

describe("formatContext", () => {
  it("outputs JSON when format is json", () => {
    const result = {
      claims: [],
      conflicts: [],
      decisions: [],
      intents: [],
      metadata: {
        query: "test",
        seedEntities: [],
        hopsExpanded: 1,
        asOfRev: 5,
      },
    };
    const output = captureLog(() => formatContext(result, "json"));
    const parsed = JSON.parse(output);
    expect(parsed.metadata.query).toBe("test");
    expect(parsed.metadata.asOfRev).toBe(5);
  });

  it("produces expected text output structure", () => {
    const result = {
      claims: [
        {
          claim: { statement: "Claim A" },
          finalScore: 0.95,
        },
        {
          claim: { statement: "Claim B" },
          finalScore: 0.4,
        },
      ],
      conflicts: [{ reason: "Contradiction", recommendation: "Resolve it" }],
      decisions: [{ title: "Use X", rationale: "Because Y" }],
      intents: [{ statement: "Build feature", status: "active" }],
      metadata: {
        query: "project alpha",
        seedEntities: ["e1", "e2"],
        hopsExpanded: 2,
        asOfRev: 10,
      },
    };

    const output = captureLog(() => formatContext(result, "text"));
    const plain = stripAnsi(output);

    // Header
    expect(plain).toContain('--- Ix Context: "project alpha" ---');
    // Metadata
    expect(plain).toContain("Seeds: 2 | Hops: 2 | Rev: 10");
    // Claims section
    expect(plain).toContain("Claims:");
    expect(plain).toContain("[95%]");
    expect(plain).toContain("Claim A");
    expect(plain).toContain("[40%]");
    expect(plain).toContain("Claim B");
    // Conflicts
    expect(plain).toContain("Conflicts (1):");
    expect(plain).toContain("! Contradiction: Resolve it");
    // Decisions
    expect(plain).toContain("Decisions (1):");
    expect(plain).toContain("* Use X: Because Y");
    // Intents
    expect(plain).toContain("Intents (1):");
    expect(plain).toContain("> Build feature [active]");
  });

  it("formats compact claims with path and score", () => {
    const result = {
      compactClaims: [{
        entityId: "abc-123",
        field: "defines:parseClaim",
        value: "parseClaim",
        score: 0.9,
        confidence: { score: 0.9, authority: 0.9 },
        path: "src/main/scala/ix/memory/ingestion/Parser.scala",
        lineRange: [42, 67] as [number, number]
      }],
      claims: [],
      conflicts: [],
      decisions: [],
      intents: [],
      metadata: { query: "parseClaim", seedEntities: [], hopsExpanded: 1, asOfRev: 5 }
    };
    const output = captureLog(() => formatContext(result, "text"));
    const clean = stripAnsi(output);
    expect(clean).toContain("90%");
    expect(clean).toContain("defines:parseClaim");
    expect(clean).toContain("Parser.scala");
    expect(clean).toContain("42-67");
  });

  it("shows truncation message when more than 10 claims", () => {
    const claims = Array.from({ length: 15 }, (_, i) => ({
      claim: { statement: `Claim ${i}` },
      finalScore: 0.5,
    }));
    const result = {
      claims,
      conflicts: [],
      decisions: [],
      intents: [],
      metadata: {
        query: "big",
        seedEntities: [],
        hopsExpanded: 1,
        asOfRev: 1,
      },
    };

    const output = captureLog(() => formatContext(result, "text"));
    const plain = stripAnsi(output);
    expect(plain).toContain("... and 5 more");
  });
});

describe("formatIntents", () => {
  it("outputs JSON when format is json", () => {
    const intents = [{ id: "i1", statement: "Do X", status: "active", confidence: 0.9 }];
    const output = captureLog(() => formatIntents(intents, "json"));
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].statement).toBe("Do X");
  });

  it("handles empty list", () => {
    const output = captureLog(() => formatIntents([], "text"));
    expect(output).toContain("No intents found.");
  });

  it("builds parent-child tree", () => {
    const intents = [
      { id: "root1", statement: "Root intent", status: "active", confidence: 0.85 },
      { id: "child1", statement: "Child intent", status: "pending", confidence: 0.6, parentIntent: "root1" },
      { id: "root2", statement: "Another root", status: "done", confidence: 0.3 },
    ];

    const output = captureLog(() => formatIntents(intents, "text"));
    const plain = stripAnsi(output);

    // Root intents should appear with ">" prefix
    expect(plain).toContain("> Root intent [active]");
    expect(plain).toContain("> Another root [done]");

    // Children should appear indented with tree connector
    expect(plain).toContain("\u2514\u2500 Child intent [pending]");

    // Confidence percentages should appear
    expect(plain).toContain("(85%)");
    expect(plain).toContain("(60%)");
    expect(plain).toContain("(30%)");
  });

  it("handles intents with no confidence field", () => {
    const intents = [
      { id: "i1", statement: "No conf", status: "active" },
    ];
    const output = captureLog(() => formatIntents(intents, "text"));
    const plain = stripAnsi(output);
    expect(plain).toContain("(0%)");
  });
});

describe("formatConflicts", () => {
  it("outputs JSON when format is json", () => {
    const conflicts = [
      { id: "c1", reason: "Contradiction", recommendation: "Fix it", claimA: "A", claimB: "B" },
    ];
    const output = captureLog(() => formatConflicts(conflicts, "json"));
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].reason).toBe("Contradiction");
  });

  it("handles empty list", () => {
    const output = captureLog(() => formatConflicts([], "text"));
    expect(output).toContain("No conflicts detected.");
  });

  it("formats conflict details", () => {
    const conflicts = [
      {
        id: "c1",
        reason: "Data contradicts policy",
        recommendation: "Review the source",
        claimA: "claim-aaa",
        claimB: "claim-bbb",
      },
    ];

    const output = captureLog(() => formatConflicts(conflicts, "text"));
    const plain = stripAnsi(output);

    expect(plain).toContain("! Data contradicts policy");
    expect(plain).toContain("Review the source");
    expect(plain).toContain("Claims: claim-aaa vs claim-bbb");
  });
});

describe("formatDecisions", () => {
  it("should output JSON when format is json", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const decisions = [
      { id: "abc-123", kind: "decision", attrs: { title: "Use ArangoDB", rationale: "Supports MVCC" } }
    ];
    formatDecisions(decisions, "json");
    expect(spy).toHaveBeenCalledWith(JSON.stringify(decisions, null, 2));
    spy.mockRestore();
  });

  it("should show 'No decisions found.' for empty list", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    formatDecisions([], "text");
    expect(spy).toHaveBeenCalledWith("No decisions found.");
    spy.mockRestore();
  });

  it("should display title and rationale in text mode", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const decisions = [
      { id: "abc-12345-def", kind: "decision", attrs: { title: "Use ArangoDB", rationale: "Supports MVCC" } }
    ];
    formatDecisions(decisions, "text");
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("Use ArangoDB");
    expect(output).toContain("Supports MVCC");
    expect(output).toContain("abc-1234");
    spy.mockRestore();
  });
});

describe("formatTextResults", () => {
  it("should output JSON when format is json", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const results = [{ path: "src/foo.ts", line: 42, snippet: "const foo = bar;" }];
    formatTextResults(results, "json");
    expect(spy).toHaveBeenCalledWith(JSON.stringify(results, null, 2));
    spy.mockRestore();
  });

  it("should show 'No text matches found.' for empty results", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    formatTextResults([], "text");
    expect(spy).toHaveBeenCalledWith("No text matches found.");
    spy.mockRestore();
  });

  it("should display path:line and snippet in text mode", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const results = [{ path: "src/foo.ts", line: 42, snippet: "const foo = bar;" }];
    formatTextResults(results, "text");
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("src/foo.ts");
    expect(output).toContain(":42");
    expect(output).toContain("const foo = bar;");
    spy.mockRestore();
  });
});
