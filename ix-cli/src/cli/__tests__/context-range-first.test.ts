// Copyright 2026 Ix Infrastructure Inc.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextReads, renderBundle } from "../commands/context.js";
import { readsOneSymbol } from "../commands/read.js";

// renderBundle vets each symbol read against the file on disk (readsOneSymbol).
// The bundles here name files that do not exist, so the check is stubbed for
// the render tests; the real one is tested against a temp tree at the end.
vi.mock("../commands/read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/read.js")>()),
  readsOneSymbol: vi.fn(() => true),
}));

function bundleWith(evidence: Array<Record<string, unknown>>): never {
  return { evidence } as never;
}

function row(title: string, path?: string, lineStart?: number, lineEnd?: number) {
  return {
    id: title, kind: "structural", source: "facts.members", title, score: 10, reason: "", refs: [],
    ...(path ? { location: { path, lineStart, lineEnd } } : {}),
  };
}

describe("nextReads", () => {
  it("hands back ready-to-run commands, in evidence order", () => {
    expect(
      nextReads(bundleWith([
        row("target", "src/a.ts", 15, 27),
        row("caller", "src/b.ts", 17, 145),
      ])),
    ).toEqual([
      { cmd: "ix read src/a.ts:15-27", stale: false },
      { cmd: "ix read src/b.ts:17-145", stale: false },
    ]);
  });

  it("stops at three, so the closing instruction stays a closing instruction", () => {
    const reads = nextReads(bundleWith(
      [1, 2, 3, 4, 5].map((n) => row(`m${n}`, `src/${n}.ts`, n, n + 10)),
    ));
    expect(reads).toHaveLength(3);
  });

  it("does not repeat a range a caller and a dependent both name", () => {
    // The same function arrives twice in most bundles, once per relation.
    expect(
      nextReads(bundleWith([
        row("caller handleLogin", "src/b.ts", 17, 145),
        row("dependent handleLogin", "src/b.ts", 17, 145),
        row("member parse", "src/c.ts", 4, 9),
      ])),
    ).toEqual([
      { cmd: "ix read src/b.ts:17-145", stale: false },
      { cmd: "ix read src/c.ts:4-9", stale: false },
    ]);
  });

  it("skips a row that has no range, rather than emitting a whole-file read", () => {
    // A file entity carries a path and no span on purpose. Turning that into
    // `ix read src/huge.ts` is exactly the 34-61k-character read this is here
    // to avoid.
    expect(
      nextReads(bundleWith([
        row("container config.ts (file)", "src/huge.ts"),
        row("member parse", "src/c.ts", 4, 9),
      ])),
    ).toEqual([{ cmd: "ix read src/c.ts:4-9", stale: false }]);
  });

  it("says nothing when nothing in the bundle is ranged", () => {
    expect(nextReads(bundleWith([row("a"), row("b", "src/x.ts")]))).toEqual([]);
  });
});

type Entity = { id: string; name: string; kind: string; path?: string; stale: boolean };

function entity(id: string, name: string, kind: string, path: string, stale = false): Entity {
  return { id, name, kind, path, stale };
}

function refRow(title: string, ref: string, path: string, lineStart: number, lineEnd: number, kind = "structural") {
  return { ...row(title, path, lineStart, lineEnd), kind, refs: [ref] };
}

const TARGET = { id: "s-list", name: "listByKind", kind: "method", resolutionMode: "exact", path: "src/client/api.ts" };

function fullBundle(
  evidence: Array<Record<string, unknown>>,
  entities: Entity[],
  targetStale = false,
): never {
  return { target: TARGET, evidence, entities, freshness: { stale: targetStale, classification: "current" } } as never;
}

describe("nextReads re-anchors a stale row through the symbol", () => {
  it("names the symbol and pins its file when the file changed", () => {
    expect(
      nextReads(fullBundle(
        [refRow("member parse", "f-parse", "src/c.ts", 4, 9)],
        [entity("f-parse", "parse", "function", "src/c.ts", true)],
      )),
    ).toEqual([{ cmd: "ix read parse --path src/c.ts", stale: true }]);
  });

  // The range is exact in a fresh file and never fails; a symbol read can
  // (live: `ix read add --path core-ingestion/src/role-classifier.ts` exit 1).
  it("keeps the exact range for a symbol in a fresh file", () => {
    expect(
      nextReads(fullBundle(
        [refRow("member parse", "f-parse", "src/c.ts", 4, 9)],
        [entity("f-parse", "parse", "function", "src/c.ts")],
      ), 3, () => {
        throw new Error("a fresh row needs no disk check");
      }),
    ).toEqual([{ cmd: "ix read src/c.ts:4-9", stale: false }]);
  });

  it("takes the target row's name from the bundle's target", () => {
    expect(
      nextReads(fullBundle([refRow("listByKind (method)", "s-list", "src/client/api.ts", 141, 152, "target")], [], true)),
    ).toEqual([{ cmd: "ix read listByKind --path src/client/api.ts", stale: true }]);
  });

  it("keeps the target row's range when the target is fresh", () => {
    expect(
      nextReads(fullBundle([refRow("listByKind (method)", "s-list", "src/client/api.ts", 141, 152, "target")], [])),
    ).toEqual([{ cmd: "ix read src/client/api.ts:141-152", stale: false }]);
  });

  it("keeps the range for a file or module, an unsafe name, or a name used twice in one file", () => {
    expect(
      nextReads(fullBundle(
        [
          refRow("file", "d-file", "src/f.ts", 1, 50),
          refRow("module", "d-mod", "src/m.ts", 1, 60),
          refRow("odd name", "d-odd", "src/o.ts", 3, 8),
          refRow("first constructor", "k-1", "src/k.ts", 10, 20),
        ],
        [
          entity("d-file", "f.ts", "file", "src/f.ts", true),
          entity("d-mod", "m", "Module", "src/m.ts", true),
          entity("d-odd", "operator ==", "method", "src/o.ts", true),
          entity("k-1", "constructor", "method", "src/k.ts", true),
          entity("k-2", "constructor", "method", "src/k.ts", true),
        ],
      ), 4),
    ).toEqual([
      { cmd: "ix read src/f.ts:1-50", stale: true },
      { cmd: "ix read src/m.ts:1-60", stale: true },
      { cmd: "ix read src/o.ts:3-8", stale: true },
      { cmd: "ix read src/k.ts:10-20", stale: true },
    ]);
  });

  it("still collapses a caller and a dependent naming the same range", () => {
    expect(
      nextReads(fullBundle(
        [
          refRow("caller handleLogin", "f-login", "src/b.ts", 17, 145),
          refRow("dependent handleLogin", "f-login", "src/b.ts", 17, 145),
        ],
        [entity("f-login", "handleLogin", "function", "src/b.ts", true)],
      )),
    ).toEqual([{ cmd: "ix read handleLogin --path src/b.ts", stale: true }]);
  });

  it("flags a row whose file changed since the last ingest", () => {
    const reads = nextReads(fullBundle(
      [
        refRow("listByKind (method)", "s-list", "src/client/api.ts", 141, 152, "target"),
        refRow("member parse", "f-parse", "src/c.ts", 4, 9),
        refRow("caller run", "f-run", "src/d.ts", 30, 40),
        refRow("calls helper", "f-help", "src/e.ts", 1, 5),
      ],
      [
        entity("f-parse", "parse", "function", "src/c.ts", true),
        entity("f-run", "run", "function", "src/d.ts"),
        entity("f-other", "other", "function", "src/d.ts", true),
        entity("f-help", "helper", "function", "src/e.ts"),
      ],
      true,
    ), 4);
    expect(reads).toEqual([
      { cmd: "ix read listByKind --path src/client/api.ts", stale: true },
      { cmd: "ix read parse --path src/c.ts", stale: true },
      // Stale by a sibling entity in the same file.
      { cmd: "ix read run --path src/d.ts", stale: true },
      { cmd: "ix read src/e.ts:1-5", stale: false },
    ]);
  });
});

describe("renderBundle prints the stale flag on next rows", () => {
  function captureLog(fn: () => void): string[] {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      fn();
    } finally {
      console.log = orig;
    }
    return lines.join("\n").split("\n");
  }

  function renderable(): never {
    const base = fullBundle(
      [
        refRow("member parse", "f-parse", "src/c.ts", 4, 9),
        refRow("calls helper", "f-help", "src/e.ts", 1, 5),
      ],
      [entity("f-parse", "parse", "function", "src/c.ts", true), entity("f-help", "helper", "function", "src/e.ts")],
    ) as Record<string, unknown>;
    return {
      ...base,
      relationships: [], claims: [], decisions: [], conflicts: [], intents: [],
      provenance: { historyLength: 0, stale: false },
      truncation: { entitiesTruncated: 0, relationshipsTruncated: 0, evidenceTruncated: 0, conflictsTruncated: 0, charsTruncated: 0 },
      budgets: { maxChars: 10000, maxEvidence: 20, maxEntities: 20, maxRelationships: 20 },
    } as never;
  }

  it("emits stale=true in llm records, and no stale key on a fresh row", () => {
    const next = captureLog(() => renderBundle(renderable(), "llm")).filter((l) => l.startsWith("next "));
    expect(next).toEqual([
      'next cmd="ix read parse --path src/c.ts" stale=true',
      'next cmd="ix read src/e.ts:1-5"',
    ]);
  });

  it("ends a stale row with the note in text", () => {
    const lines = captureLog(() => renderBundle(renderable(), "text"));
    expect(lines.find((l) => l.includes("ix read parse --path src/c.ts"))).toMatch(
      /\(stale: changed since last ingest; ix map to update\)$/,
    );
    expect(lines.find((l) => l.includes("ix read src/e.ts:1-5"))).not.toMatch(/stale/);
  });
});

describe("nextReads keeps the range form where the symbol read could miss", () => {
  const ev = [refRow("member parse", "f-parse", "src/c.ts", 4, 9)];
  const ents = [entity("f-parse", "parse", "function", "src/c.ts", true)];

  it("asks the check with the name and the row's file, and falls back when it says no", () => {
    const asked: Array<[string, string]> = [];
    const reads = nextReads(fullBundle(ev, ents), 3, (name, path) => {
      asked.push([name, path]);
      return false;
    });
    expect(asked).toEqual([["parse", "src/c.ts"]]);
    expect(reads).toEqual([{ cmd: "ix read src/c.ts:4-9", stale: true }]);
  });

  it("renderBundle falls back when the file on disk does not vouch for the name", () => {
    vi.mocked(readsOneSymbol).mockReturnValue(false);
    try {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
      try {
        renderBundle({
          ...(fullBundle(ev, ents) as object),
          relationships: [], claims: [], decisions: [], conflicts: [], intents: [],
          provenance: { historyLength: 0, stale: false },
          truncation: { entitiesTruncated: 0, relationshipsTruncated: 0, evidenceTruncated: 0, conflictsTruncated: 0, charsTruncated: 0 },
          budgets: { maxChars: 10000, maxEvidence: 20, maxEntities: 20, maxRelationships: 20 },
        } as never, "llm");
      } finally {
        console.log = orig;
      }
      expect(lines.join("\n").split("\n").filter((l) => l.startsWith("next "))).toEqual([
        'next cmd="ix read src/c.ts:4-9" stale=true',
      ]);
    } finally {
      vi.mocked(readsOneSymbol).mockReturnValue(true);
    }
  });
});

describe("readsOneSymbol asks the file, not the bundle", () => {
  let root: string;
  let real: typeof readsOneSymbol;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ix-next-reads-"));
    mkdirSync(join(root, "src"));
    real = (await vi.importActual<typeof import("../commands/read.js")>("../commands/read.js")).readsOneSymbol;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("says yes to a name declared once", () => {
    writeFileSync(join(root, "src/x.ts"), "export function parse(s: string) {\n  return s;\n}\n");
    expect(real(root, "parse", "src/x.ts")).toBe(true);
  });

  // The review case: the bundle for A.save lists one `save` (B.save is not a
  // neighbour), but `ix read save --path src/x.ts` would find both.
  it("says no to a name declared twice in the file, whatever the bundle lists", () => {
    writeFileSync(
      join(root, "src/x.ts"),
      "class A {\n  save(x: number) {\n    return x;\n  }\n}\nclass B {\n  save(y: number) {\n    return y;\n  }\n}\n",
    );
    expect(real(root, "save", "src/x.ts")).toBe(false);
    const ev = [refRow("A.save (method)", "a-save", "src/x.ts", 2, 4, "target")];
    const target = { id: "a-save", name: "save", kind: "method", resolutionMode: "exact", path: "src/x.ts" };
    const bundle = { target, evidence: ev, entities: [], freshness: { stale: true } } as never;
    expect(nextReads(bundle, 3, (name, path) => real(root, name, path)))
      .toEqual([{ cmd: "ix read src/x.ts:2-4", stale: true }]);
  });

  it("says no when no line declares the name, or the file is missing", () => {
    writeFileSync(join(root, "src/x.ts"), "const y = parse(1);\n");
    expect(real(root, "parse", "src/x.ts")).toBe(false);
    expect(real(root, "parse", "src/missing.ts")).toBe(false);
  });

  // ix read hides test and fixture symbols when a production one shares the
  // name, before --path narrows: `ix read bundle --path x.test.ts` exits 1.
  it("says no for a file ingest may have filed as a test or fixture", () => {
    const decl = "export function parse(s: string) {\n  return s;\n}\n";
    mkdirSync(join(root, "src/__tests__"));
    mkdirSync(join(root, "src/fixtures"));
    writeFileSync(join(root, "src/__tests__/x.ts"), decl);
    writeFileSync(join(root, "src/fixtures/x.ts"), decl);
    writeFileSync(join(root, "src/x.test.ts"), decl);
    writeFileSync(join(root, "src/XTest.java"), decl);
    writeFileSync(join(root, "src/helpers.ts"), `import { it } from "vitest";\n${decl}`);
    writeFileSync(join(root, "src/latest.ts"), decl);
    for (const file of ["src/__tests__/x.ts", "src/fixtures/x.ts", "src/x.test.ts", "src/XTest.java", "src/helpers.ts"]) {
      expect(real(root, "parse", file), file).toBe(false);
    }
    expect(real(root, "parse", "src/latest.ts")).toBe(true);
  });

  it("says no when a file has the name as its basename, since ix read opens it first", () => {
    writeFileSync(join(root, "src/x.ts"), "export function parse(s: string) {\n  return s;\n}\n");
    writeFileSync(join(root, "src/parse.ts"), "export {};\n");
    expect(real(root, "parse", "src/x.ts")).toBe(false);
  });

  // --path is a substring test on the source path, so `--path src/util.ts`
  // also keeps lib/src/util.ts and src/util.tsx, and a `parse` there makes
  // the read ambiguous. The range form reads the right file whatever else exists.
  it("says no when another file's path contains the suggested path", () => {
    const decl = "export function parse(s: string) {\n  return s;\n}\n";
    writeFileSync(join(root, "src/util.ts"), decl);
    expect(real(root, "parse", "src/util.ts")).toBe(true);
    mkdirSync(join(root, "lib/src"), { recursive: true });
    writeFileSync(join(root, "lib/src/util.ts"), decl);
    expect(real(root, "parse", "src/util.ts")).toBe(false);
    rmSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "src/util.tsx"), decl);
    expect(real(root, "parse", "src/util.ts")).toBe(false);
    rmSync(join(root, "src/util.tsx"));
    // A path that does not contain the suggested one is no collision.
    writeFileSync(join(root, "src/my-util.ts"), decl);
    expect(real(root, "parse", "src/util.ts")).toBe(true);
  });
});
