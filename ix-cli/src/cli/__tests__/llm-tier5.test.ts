import { describe, it, expect, vi } from "vitest";
import { renderExplainLlm, renderExplainRawLlm } from "../explain/llm.js";
import { renderReadLlm, renderReadAmbiguityLlm, outputResult } from "../commands/read.js";
import type { ReadResult } from "../commands/read.js";
import { renderStatusLlm } from "../commands/status.js";
import { renderDoctorLlm } from "../commands/doctor.js";
import { renderSavingsLlm } from "../commands/savings.js";
import type { EntityFacts } from "../explain/facts.js";

/**
 * The commands that advertised `llm` in their help and rendered `text`.
 *
 * docs/llm-format.md says an unimplemented command routes `--format llm` to
 * "whichever existing format is most compact", which for all five of these was
 * the prose renderer — so agents paid full human-oriented output on the path
 * they call most. These tests pin the records, and in particular the two
 * properties that are easy to regress: zero counts survive, and a value that
 * would break the one-record-per-line invariant gets quoted.
 */

function facts(over: Partial<EntityFacts> = {}): EntityFacts {
  return {
    id: "e1", name: "IngestionService", kind: "class",
    path: "src/ingest.ts",
    members: [], memberCount: 0,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    downstreamDependents: 0, downstreamDepth: 0,
    topCallers: [], topDependents: [],
    historyLength: 0,
    stale: false,
    diagnostics: [],
    ...over,
  } as EntityFacts;
}

const role = { role: "service", confidence: "high", reasons: [] } as any;
const importance = { level: "high", category: "broad-shared-dependency", reasons: [] } as any;
const rendered = {
  explanation: "PROSE_EXPLANATION", context: "PROSE_CONTEXT",
  usedBy: null, whyItMatters: "PROSE_WHY", notes: [],
};

describe("explain --format llm", () => {
  it("emits the facts, not the prose that was rendered from them", () => {
    const lines = renderExplainLlm(
      facts({ callerCount: 12, dependentCount: 40, introducedRev: 7 }),
      role, importance, rendered,
    );

    expect(lines[0]).toBe("entity id=e1 name=IngestionService kind=class path=src/ingest.ts rev=7");
    expect(lines).toContain("role role=service confidence=high");
    expect(lines).toContain("importance level=high category=broad-shared-dependency");
    // The whole point: none of the prose survives. It is a rendering of the
    // records above, so an agent that gets the records can drop it.
    expect(lines.join("\n")).not.toContain("PROSE_EXPLANATION");
    expect(lines.join("\n")).not.toContain("PROSE_CONTEXT");
    expect(lines.join("\n")).not.toContain("PROSE_WHY");
  });

  it("keeps zero counts, because 'nothing calls this' is an answer", () => {
    const line = renderExplainLlm(facts(), role, importance, rendered)
      .find(l => l.startsWith("edges "));

    // llmField drops "" but keeps "0" — if these were passed as numbers a
    // future change to that rule would silently delete the answer.
    expect(line).toBe("edges callers=0 callees=0 dependents=0 importers=0 members=0 downstream=0 depth=0 history=0");
  });

  it("marks stale sources and carries diagnostics through", () => {
    const lines = renderExplainLlm(
      facts({ stale: true, diagnostics: [{ code: "stale_source", message: "File changed since ingest." }] }),
      role, importance, rendered,
    );

    expect(lines[0]).toContain("stale=true");
    expect(lines).toContain('diagnostic code=stale_source message="File changed since ingest."');
  });

  it("quotes a signature so a record never spans two lines", () => {
    const lines = renderExplainLlm(
      facts({ signature: "run(a: string,\n      b: number): void" }),
      role, importance, rendered,
    );

    const sig = lines.find(l => l.startsWith("signature "))!;
    expect(sig).toContain("\\n");
    expect(sig.split("\n")).toHaveLength(1);
  });

  it("renders the --raw dump as records too", () => {
    const lines = renderExplainRawLlm({
      id: "e1", name: "verify_token", kind: "function", file: "src/auth.py",
      calledBy: 3, calls: 1, contains: 0, historyLength: 2,
      callList: [{ name: "decode", kind: "function", resolved: true }],
    });

    expect(lines[0]).toBe("entity id=e1 name=verify_token kind=function path=src/auth.py");
    expect(lines).toContain("edges called_by=3 calls=1 contains=0 history=2");
    expect(lines).toContain("call name=decode kind=function");
  });
});

describe("read --format llm", () => {
  it("drops the per-line gutter and self-delimits the payload", () => {
    const lines = renderReadLlm({
      targetType: "symbol", path: "/repo/src/auth.py",
      lineStart: 10, lineEnd: 12,
      content: "def verify():\n    return True\n",
      symbol: "verify", kind: "function",
    } as any);

    expect(lines[0]).toContain("line_start=10");
    expect(lines[0]).toContain("symbol=verify");
    // content lines=<n> tells the consumer exactly how many lines follow, so a
    // line of source can never be mistaken for another record.
    expect(lines[1]).toBe("content lines=3");
    expect(lines.slice(2)).toEqual(["def verify():", "    return True", ""]);
    // No line number prefixes anywhere.
    expect(lines.slice(2).some(l => /^\s*\d+ /.test(l))).toBe(false);
  });

  it("lists candidates when the target is ambiguous", () => {
    const lines = renderReadAmbiguityLlm({
      targetType: "ambiguous-symbol",
      candidates: [
        { name: "run", kind: "function", path: "/repo/a.ts" },
        { name: "run", kind: "method", path: "/repo/b.ts" },
      ],
    } as any, "run");

    expect(lines[0]).toBe("ambiguous kind=symbol target=run count=2");
    expect(lines[1]).toContain("candidate n=1 name=run kind=function");
    expect(lines[lines.length - 1]).toContain("--pick");
  });
});

describe("status --format llm", () => {
  it("answers 'can I trust the graph' in one field", () => {
    const lines = renderStatusLlm("ok", "http://localhost:8090", {
      mapCompleted: true,
      currentRev: 11, lastIngestAt: "2026-08-09T12:00:00.000Z",
      staleFiles: 2, sampleChangedFiles: ["src/a.ts", "src/b.ts"],
    });

    expect(lines[0]).toContain("stale=true");
    expect(lines[0]).toContain("stale_files=2");
    // ISO, not "3h ago" — the consumer can do its own arithmetic.
    expect(lines[0]).toContain("last_ingest_at=2026-08-09T12:00:00.000Z");
    expect(lines).toContain("changed path=src/a.ts");
  });

  it("says stale=false rather than omitting it when the graph is current", () => {
    const lines = renderStatusLlm("ok", "http://localhost:8090", {
      mapCompleted: true,
      currentRev: 11, lastIngestAt: null, staleFiles: 0, sampleChangedFiles: [],
    });

    expect(lines[0]).toContain("stale=false");
    expect(lines[0]).toContain("stale_files=0");
  });

  it("does not call a workspace current before any map completed", () => {
    const lines = renderStatusLlm("ok", "http://localhost:8090", {
      mapCompleted: false,
      currentRev: 0, lastIngestAt: null, staleFiles: 0, sampleChangedFiles: [],
    });

    expect(lines[0]).toContain("map_complete=false");
    expect(lines[0]).toContain("stale=true");
  });

  it("omits the staleness fields entirely when there is no baseline to read", () => {
    const lines = renderStatusLlm("ok", "http://localhost:8090", null);

    expect(lines).toEqual(["status backend=ok endpoint=http://localhost:8090"]);
  });
});

describe("doctor --format llm", () => {
  it("prints the detail instead of telling you to re-run for it", () => {
    const lines = renderDoctorLlm([
      { name: "Backend reachable", ok: true, detail: "ok" },
      { name: "Graph schema matches engine", ok: false, warn: true, detail: "graph schema v2, expected v3" },
      { name: "Docker running", ok: false, detail: "daemon not up" },
    ], true, true);

    expect(lines[0]).toBe("doctor healthy=false warnings=true checks=3");
    expect(lines).toContain('check name="Backend reachable" status=ok detail=ok');
    expect(lines).toContain('check name="Graph schema matches engine" status=warn detail="graph schema v2, expected v3"');
    expect(lines).toContain('check name="Docker running" status=fail detail="daemon not up"');
  });

  // {ok:true, warn:true} is the only shape the ternary's ordering decides —
  // `latest-not-pulled` returns it, and every other combination reads the same
  // either way round. Without this row the comment explaining why `ok` must be
  // tested first sits above an untested branch.
  //
  // `ok`, not `warn`, because that is what the glyph line renders for the same
  // record (green ✓, not yellow !). The two formats describing one check
  // differently is the bug worth guarding; the header still carries
  // warnings=true, so nothing is lost.
  it("agrees with the glyph on a check that passes with a warning", () => {
    const lines = renderDoctorLlm(
      [{ name: "Backend image", ok: true, warn: true, detail: "can't verify — :latest not pulled" }],
      false, true,
    );

    expect(lines[0]).toBe("doctor healthy=true warnings=true checks=1");
    expect(lines).toContain('check name="Backend image" status=ok detail="can\'t verify — :latest not pulled"');
  });
});

describe("savings --format llm", () => {
  const data = (over = {}) => ({
    commandCount: 10, tokensSaved: 50_000, naiveTokens: 60_000, actualTokens: 10_000,
    byCommandType: { explain: { count: 4, saved: 20_000 } },
    ...over,
  });

  it("emits one record per scope with the derived money and water", () => {
    const lines = renderSavingsLlm(
      { session: data(), lifetime: data() } as any, "opus", false,
    );

    const session = lines.find(l => l.includes("name=session"))!;
    expect(session).toContain("tokens_saved=50000");
    expect(session).toContain("water_saved_ml=100");
    expect(session).toMatch(/money_saved=\d+\.\d{2}/);
  });

  it("gates the per-command breakdown behind --detail, like the other formats", () => {
    const without = renderSavingsLlm({ session: data(), lifetime: data() } as any, "opus", false);
    const with_ = renderSavingsLlm({ session: data(), lifetime: data() } as any, "opus", true);

    expect(without.some(l => l.startsWith("command "))).toBe(false);
    expect(with_).toContain("command scope=session name=explain count=4 tokens_saved=20000");
  });
});

/**
 * The `content lines=<n>` header is only true of render *composed with* print.
 * renderReadLlm returns the blank lines correctly; printLlmLines used to drop
 * them on the way to stdout, so the count promised more lines than a consumer
 * ever received and it ate the following records as source. Asserting on the
 * returned array cannot see that — these drive the real print path.
 */
describe("read --format llm content framing", () => {
  function emit(content: string, over: Partial<ReadResult> = {}): string[] {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    });
    try {
      outputResult({
        targetType: "file", path: "/repo/src/a.ts",
        lineStart: 1, lineEnd: 1, content, stale: false,
        ...over,
      } as ReadResult, "llm");
    } finally {
      spy.mockRestore();
    }
    return out;
  }

  function framing(content: string): { declared: number; emitted: number } {
    const out = emit(content);
    const header = out.findIndex(l => l.startsWith("content lines="));
    return {
      declared: Number(/content lines=(\d+)/.exec(out[header])![1]),
      emitted: out.length - header - 1,
    };
  }

  it.each([
    ["a blank line in the middle", "def verify():\n\n    return True\n"],
    ["an empty file", ""],
    ["CRLF content", "a\r\nb\r\n"],
    ["no trailing newline", "x\ny"],
    ["only blank lines", "\n\n\n"],
  ])("emits exactly as many lines as it declares: %s", (_label, content) => {
    const { declared, emitted } = framing(content);
    expect(emitted).toBe(declared);
  });

  it("keeps the blank line in place rather than closing the gap", () => {
    const out = emit("a\n\nb\n");
    expect(out.slice(out.findIndex(l => l.startsWith("content lines=")) + 1))
      .toEqual(["a", "", "b", ""]);
  });

  it("routes --format llm to records, not the numbered gutter", () => {
    const out = emit("x\ny");
    expect(out[0]).toContain("file path=");
    expect(out.some(l => /^\s*\d+ /.test(l))).toBe(false);
  });
});
