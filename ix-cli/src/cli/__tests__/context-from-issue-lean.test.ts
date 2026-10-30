// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import {
  detectContextModeConflict,
  renderLeanIssueLlm,
  renderLeanIssueText,
} from "../commands/context.js";
import {
  isGenericIdentifier,
  issueConfidence,
  leanIssueView,
  LEAN_RANKED,
  type IssuePlan,
  type StartingPoint,
} from "../explain/issue.js";

/**
 * `ix context --from-issue --lean`: the starting points Ix trusts and a few
 * ranked files, or one line saying it trusts none. A full bundle is ~1.5k
 * tokens an agent re-reads every turn; on SWE-PolyBench it added a median 14%
 * tokens even where its start was right.
 */

function ident(token: string, path: string, extra: Partial<StartingPoint> = {}): StartingPoint {
  return { token, id: `n-${token}`, name: token, kind: "class", path, lineStart: 10, lineEnd: 40,
    via: "identifier in issue", ...extra };
}

function plan(starts: StartingPoint[], extra: Partial<IssuePlan> = {}): IssuePlan {
  return {
    starts,
    unresolved: [],
    fallback: false,
    bm25: [
      { path: "src/a.ts", score: 9 }, { path: "src/b.ts", score: 8 }, { path: "src/c.ts", score: 7 },
      { path: "src/d.ts", score: 6 }, { path: "src/e.ts", score: 5 }, { path: "src/f.ts", score: 4 },
    ],
    ...extra,
  } as IssuePlan;
}

describe("isGenericIdentifier", () => {
  it.each(["debug", "bind", "config", "render", "version", "ignore", "Service", "parse"])(
    "treats %s as too common to point anywhere", (t) => expect(isGenericIdentifier(t)).toBe(true));

  it.each(["toJsonTree", "JsonWriter", "get_openai_callback", "KerasTensor", "PojoUtils", "computeIfAbsent", "recurrent"])(
    "treats %s as specific", (t) => expect(isGenericIdentifier(t)).toBe(false));
});

describe("issueConfidence", () => {
  it("never trusts a BM25 fallback", () => {
    const c = issueConfidence(plan([{ token: "src/a.ts", name: "a.ts", kind: "file", path: "src/a.ts", via: "bm25 fallback" }],
      { fallback: true }));
    expect(c.confident).toBe(false);
    expect(c.reason).toMatch(/no code name in the issue resolved/);
  });

  it("does not trust a plan whose only starts are common words", () => {
    const c = issueConfidence(plan([ident("debug", "src/ssr.ts"), ident("bind", "src/dom.ts")]));
    expect(c.confident).toBe(false);
    expect(c.reason).toContain("debug, bind");
  });

  it("keeps named paths and specific identifiers, and drops the common words beside them", () => {
    const c = issueConfidence(plan([
      ident("config", "src/config.ts"),
      ident("JsonWriter", "src/JsonWriter.java"),
      { token: "lib/deploy.js", name: "deploy.js", kind: "file", path: "lib/deploy.js", via: "path in issue" },
    ]));
    expect(c.confident).toBe(true);
    expect(c.starts.map((s) => s.token)).toEqual(["JsonWriter", "lib/deploy.js"]);
  });
});

describe("leanIssueView", () => {
  it("lists the trusted starts, then the next files by BM25 without repeating a start", () => {
    const view = leanIssueView(plan([ident("JsonWriter", "src/b.ts")]));
    expect(view.confidence).toBe("high");
    expect(view.startingPoints.map((s) => s.path)).toEqual(["src/b.ts"]);
    expect(view.alsoRanked.map((f) => f.path)).toEqual(["src/a.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
    expect(view.alsoRanked).toHaveLength(LEAN_RANKED);
  });

  it("points at nothing when it trusts nothing", () => {
    const view = leanIssueView(plan([ident("debug", "src/ssr.ts")]));
    expect(view).toMatchObject({ confidence: "low", startingPoints: [], alsoRanked: [] });
  });
});

describe("lean rendering", () => {
  const high = leanIssueView(plan([ident("JsonWriter", "src/b.ts")]));
  const low = leanIssueView(plan([], { fallback: true }));

  it("is a few lines, each start a path:lines with why", () => {
    const text = renderLeanIssueText(high);
    expect(text).toContain("src/b.ts:10-40  JsonWriter (class) — the issue names `JsonWriter`");
    expect(text).toContain("Then, by the issue's text: src/a.ts, src/c.ts, src/d.ts, src/e.ts");
    expect(text.length / 4).toBeLessThan(150);
  });

  it("says so in one line when there is no confident start", () => {
    expect(renderLeanIssueText(low).split("\n")).toHaveLength(1);
    expect(renderLeanIssueText(low)).toMatch(/^Ix found no confident starting point/);
  });

  it("renders llm records", () => {
    const lines = renderLeanIssueLlm(high);
    expect(lines[0]).toBe("issue confidence=high");
    expect(lines[1]).toMatch(/^start path=src\/b.ts lines=10-40 name=JsonWriter kind=class why=/);
    expect(lines.filter((l) => l.startsWith("ranked "))).toHaveLength(LEAN_RANKED);
    expect(renderLeanIssueLlm(low)[0]).toMatch(/^issue confidence=low reason=/);
  });
});

describe("--lean flag conflicts", () => {
  it("needs --from-issue", () => {
    expect(detectContextModeConflict({ lean: true }, "Widget")).toMatch(/--lean only shapes a bundle built with --from-issue/);
  });

  it("cannot be saved", () => {
    expect(detectContextModeConflict({ lean: true, fromIssue: "i.md", save: "x" })).toMatch(/--lean cannot be combined with --save/);
  });

  it("is accepted with --from-issue", () => {
    expect(detectContextModeConflict({ lean: true, fromIssue: "i.md" })).toBeUndefined();
  });
});
