// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";

import { IxClient } from "../../client/api.js";
import { renderLeanIssueLlm, renderLeanIssueText } from "../commands/context.js";
import { leanIssueView, pickStartingPoints, type IssuePlan, type LeanIssueView, type StartingPoint } from "../explain/issue.js";
import {
  addUsedIn,
  USED_IN_LISTED,
  USED_IN_WIDELY,
  usesFromContext,
  withUsedIn,
} from "../explain/issue-used-in.js";

/**
 * The lean issue view's "used in" line: for the first two symbols the issue
 * names, the files outside the symbol's own file that use it, from one bounded
 * graph request. Whatever goes wrong, the view is today's, byte for byte.
 */

function ident(token: string, path: string, extra: Partial<StartingPoint> = {}): StartingPoint {
  return { token, id: `n-${token}`, name: token, kind: "function", path, lineStart: 40, lineEnd: 88,
    via: "identifier in issue", ...extra };
}

function fileStart(path: string): StartingPoint {
  return { token: path, id: `f-${path}`, name: path, kind: "file", path, via: "path in issue" };
}

function viewOf(starts: StartingPoint[], extra: Partial<IssuePlan> = {}): LeanIssueView {
  return leanIssueView({
    starts,
    unresolved: [],
    fallback: false,
    bm25: [{ path: "src/a.ts", score: 9 }, { path: "src/b.ts", score: 8 }],
    ...extra,
  } as IssuePlan);
}

/** A whole-node context response: `uses` maps a target id to [caller file, predicate] pairs. */
function context(uses: Record<string, Array<[string, string?]>>) {
  const nodes: any[] = [];
  const edges: any[] = [];
  let n = 0;
  for (const [dst, callers] of Object.entries(uses)) {
    for (const [file, predicate = "CALLS"] of callers) {
      const id = `c${n++}`;
      nodes.push({ id, kind: "function", name: id, attrs: {}, provenance: { sourceUri: file } });
      edges.push({ id: `e${n}`, src: id, dst, predicate });
    }
  }
  return { nodes, edges, claims: [], conflicts: [], decisions: [], intents: [], metadata: {} };
}

function stubFetch(answer: (body: any) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    return answer(body);
  });
  return calls;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("usesFromContext", () => {
  it("counts incoming CALLS, IMPORTS and REFERENCES per file, and nothing else", () => {
    const ctx = context({ "n-parseConfig": [["src/cli/run.ts"], ["src/cli/run.ts", "REFERENCES"], ["src/boot.ts", "imports"]] });
    ctx.edges.push({ id: "x1", src: "c0", dst: "n-parseConfig", predicate: "CONTAINS" });
    ctx.edges.push({ id: "x2", src: "n-parseConfig", dst: "c0", predicate: "CALLS" });
    const uses = usesFromContext(ctx as any, ["n-parseConfig"]);
    expect([...uses.get("n-parseConfig")!]).toEqual([["src/cli/run.ts", 2], ["src/boot.ts", 1]]);
  });

  it("reads summaries when the backend sent no whole nodes", () => {
    const uses = usesFromContext({
      nodes: [], edges: [],
      nodeSummaries: [{ id: "a", kind: "function", name: "a", rev: 1, path: "src/x.ts" }, { id: "b", kind: "function", name: "b", rev: 1 }],
      edgeSummaries: [{ id: "e1", src: "a", dst: "n", predicate: "CALLS", rev: 1 }, { id: "e2", src: "b", dst: "n", predicate: "CALLS", rev: 1 }],
    } as any, ["n"]);
    expect([...uses.get("n")!]).toEqual([["src/x.ts", 1]]);
  });
});

describe("withUsedIn", () => {
  const view = viewOf([ident("parseConfig", "src/config.ts")]);

  it("lists files outside the symbol's own, tests excluded, by uses then path, the rest counted", () => {
    const callers: Array<[string]> = [
      ["src/config.ts"], ["src/config.ts"], // its own file
      ["src/__tests__/config.test.ts"], ["tests/test_config.py"], // tests
      ["src/z.ts"], ["src/z.ts"], ["src/z.ts"],
      ["src/b.ts"], ["src/b.ts"],
      ["src/a.ts"], ["src/a.ts"],
      ["src/c.ts"], ["src/d.ts"], ["src/e.ts"], ["src/f.ts"],
    ];
    const out = withUsedIn(view, usesFromContext(context({ "n-parseConfig": callers }) as any, ["n-parseConfig"]));
    expect(out.startingPoints[0].usedIn).toEqual({ files: ["src/z.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], total: 7 });
    expect(out.startingPoints[0].usedIn!.files).toHaveLength(USED_IN_LISTED);
  });

  it(`says widely, with no list, above ${USED_IN_WIDELY} files`, () => {
    const many = Array.from({ length: USED_IN_WIDELY + 1 }, (_, i): [string] => [`src/m${i}.ts`]);
    const out = withUsedIn(view, usesFromContext(context({ "n-parseConfig": many }) as any, ["n-parseConfig"]));
    expect(out.startingPoints[0].usedIn).toEqual({ files: [], total: USED_IN_WIDELY + 1, widely: true });
    expect(renderLeanIssueText(out)).toContain(`    used in: widely (${USED_IN_WIDELY + 1} files)`);
    expect(renderLeanIssueLlm(out)).toContain(`used_in name=parseConfig widely=true total=${USED_IN_WIDELY + 1}`);

    const exactly = many.slice(0, USED_IN_WIDELY);
    const listed = withUsedIn(view, usesFromContext(context({ "n-parseConfig": exactly }) as any, ["n-parseConfig"]));
    expect(listed.startingPoints[0].usedIn).toMatchObject({ total: USED_IN_WIDELY, files: expect.any(Array) });
    expect(listed.startingPoints[0].usedIn!.widely).toBeUndefined();
  });

  it("adds nothing for a symbol used only in its own file or by tests", () => {
    const out = withUsedIn(view, usesFromContext(context({
      "n-parseConfig": [["src/config.ts"], ["src/config.test.ts"]],
    }) as any, ["n-parseConfig"]));
    expect(out).toBe(view);
    expect(renderLeanIssueText(out)).toBe(renderLeanIssueText(viewOf([ident("parseConfig", "src/config.ts")])));
  });

  it("never gives a file start a line", () => {
    const v = viewOf([fileStart("src/config.ts")]);
    const out = withUsedIn(v, new Map([["f-src/config.ts", new Map([["src/other.ts", 3]])]]));
    expect(out).toBe(v);
  });
});

describe("lean rendering with used in", () => {
  const view = viewOf([ident("parseConfig", "src/config.ts")]);
  const callers: Array<[string]> = ["src/cli/run.ts", "src/server/boot.ts", "src/tools/check.ts", "src/x1.ts", "src/x2.ts", "src/x3.ts", "src/x4.ts"]
    .map((p) => [p]);
  const out = withUsedIn(view, usesFromContext(context({ "n-parseConfig": callers }) as any, ["n-parseConfig"]));

  it("text: one indented line under the start", () => {
    const lines = renderLeanIssueText(out).split("\n");
    const at = lines.findIndex((l) => l.includes("parseConfig (function)"));
    expect(lines[at]).toBe("  src/config.ts:40-88  parseConfig (function) — the issue names `parseConfig`");
    expect(lines[at + 1]).toBe("    used in: src/cli/run.ts, src/server/boot.ts, src/tools/check.ts, src/x1.ts, src/x2.ts (+2 more)");
    expect(lines).toHaveLength(renderLeanIssueText(view).split("\n").length + 1);
  });

  it("llm: a used_in record after the start record", () => {
    const lines = renderLeanIssueLlm(out);
    const at = lines.findIndex((l) => l.startsWith("start "));
    expect(lines[at + 1]).toBe(
      "used_in name=parseConfig files=src/cli/run.ts,src/server/boot.ts,src/tools/check.ts,src/x1.ts,src/x2.ts more=2 total=7");
  });

  it("llm and text: no more= or (+N more) when every file is listed", () => {
    const few = withUsedIn(view, usesFromContext(context({ "n-parseConfig": [["src/cli/run.ts"]] }) as any, ["n-parseConfig"]));
    expect(renderLeanIssueText(few)).toContain("    used in: src/cli/run.ts\n");
    expect(renderLeanIssueLlm(few)).toContain("used_in name=parseConfig files=src/cli/run.ts total=1");
  });

  it("json: usedIn on the start", () => {
    expect(JSON.parse(JSON.stringify({ kind: "issue_lean", ...out })).startingPoints[0].usedIn)
      .toEqual({ files: ["src/cli/run.ts", "src/server/boot.ts", "src/tools/check.ts", "src/x1.ts", "src/x2.ts"], total: 7 });
  });
});

describe("addUsedIn", () => {
  const three = viewOf([
    fileStart("src/named.ts"),
    ident("parseConfig", "src/config.ts"),
    ident("loadSettings", "src/settings.ts"),
    ident("writeReport", "src/report.ts"),
  ]);
  const before = {
    text: renderLeanIssueText(three),
    llm: renderLeanIssueLlm(three).join("\n"),
    json: JSON.stringify({ kind: "issue_lean", ...three }),
  };
  function same(view: LeanIssueView) {
    expect(renderLeanIssueText(view)).toBe(before.text);
    expect(renderLeanIssueLlm(view).join("\n")).toBe(before.llm);
    expect(JSON.stringify({ kind: "issue_lean", ...view })).toBe(before.json);
  }

  it("asks once for the first two symbols, never a file start or the third symbol", async () => {
    const calls = stubFetch(() => json(context({
      "n-parseConfig": [["src/cli/run.ts"]],
      "n-loadSettings": [["src/boot.ts"], ["src/boot.ts"], ["src/cli/run.ts"]],
      "n-writeReport": [["src/out.ts"]],
    })));
    const out = await addUsedIn(new IxClient("http://x"), three);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://x/v1/context");
    expect(calls[0].body.slices).toEqual([{ type: "nodes", nodeIds: ["n-parseConfig", "n-loadSettings"], expand: true, hops: 1 }]);
    expect(out.startingPoints.map((s) => s.usedIn)).toEqual([
      undefined,
      { files: ["src/cli/run.ts"], total: 1 },
      { files: ["src/boot.ts", "src/cli/run.ts"], total: 2 },
      undefined,
    ]);
  });

  // The e2e scenario's issue (fixtures/polyglot), run through the real pick
  // and confidence gate: the two names must be defined in different files, or
  // the view keeps one start per file and the batched read carries one id.
  it("gives both of the e2e issue's symbols a line, from one request with both ids", async () => {
    const defs: Record<string, string> = {
      formatPercent: "web/src/format.ts", formatPrice: "web/src/format.ts", multiply: "web/src/math.ts",
    };
    const search = async (name: string) =>
      defs[name] ? [{ id: `n-${name}`, name, kind: "function", path: defs[name] } as any] : [];
    const files = [...new Set(Object.values(defs))];
    const pick = (text: string) => pickStartingPoints(text, { files, search });

    // Two names from one file: the second gets no start, so no second id.
    const sameFile = await pick("`formatPercent` rounds 0.085 down, and `formatPrice` drops the sign of a refund.");
    expect(sameFile.starts.map((s) => s.name)).toEqual(["formatPercent"]);

    const { starts, unresolved } = await pick(
      "The tax line is wrong: `formatPercent` rounds 0.085 down, because `multiply` loses precision on fractional cents.");
    const view = leanIssueView({ starts, unresolved, fallback: false, bm25: [] } as unknown as IssuePlan);
    expect(view.confidence).toBe("high");
    expect(view.startingPoints.map((s) => s.name)).toEqual(["formatPercent", "multiply"]);

    const calls = stubFetch(() => json(context({
      "n-formatPercent": [["web/src/index.ts"]],
      "n-multiply": [["web/src/cart.ts"], ["web/src/format.ts"]],
    })));
    const out = await addUsedIn(new IxClient("http://x"), view);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.slices[0].nodeIds).toEqual(["n-formatPercent", "n-multiply"]);
    expect(out.startingPoints.map((s) => [s.name, s.usedIn])).toEqual([
      ["formatPercent", { files: ["web/src/index.ts"], total: 1 }],
      ["multiply", { files: ["web/src/cart.ts", "web/src/format.ts"], total: 2 }],
    ]);
  });

  it("sends nothing for a low-confidence view or one with only file starts", async () => {
    const calls = stubFetch(() => json(context({})));
    const low = viewOf([], { fallback: true });
    expect(await addUsedIn(new IxClient("http://x"), low)).toBe(low);
    const files = viewOf([fileStart("src/named.ts")]);
    expect(await addUsedIn(new IxClient("http://x"), files)).toBe(files);
    expect(calls).toHaveLength(0);
  });

  it("is today's output on a 404 from an older backend", async () => {
    stubFetch(() => json({ error: "not found" }, 404));
    same(await addUsedIn(new IxClient("http://x"), three));
  });

  it("is today's output on a server error or a dropped connection", async () => {
    stubFetch(() => json({ error: "boom" }, 500));
    same(await addUsedIn(new IxClient("http://x"), three));
    stubFetch(() => { throw new TypeError("fetch failed"); });
    same(await addUsedIn(new IxClient("http://x"), three));
  });

  it("is today's output on a response it cannot read", async () => {
    stubFetch(() => new Response("not json", { status: 200 }));
    same(await addUsedIn(new IxClient("http://x"), three));
    stubFetch(() => json({ edges: "nope", nodes: null }));
    same(await addUsedIn(new IxClient("http://x"), three));
  });

  it("gives up at its time bound and is today's output", async () => {
    // A backend that never answers: the fetch only ends when its signal aborts.
    vi.stubGlobal("fetch", (_url: any, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const started = Date.now();
    same(await addUsedIn(new IxClient("http://x"), three, 50));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
