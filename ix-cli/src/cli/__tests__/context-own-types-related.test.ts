// Copyright 2026 Ix Infrastructure Inc.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IxClient } from "../../client/api.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";
import type { RelatedRef } from "../explain/related-files.js";

/**
 * A class target's bases and field types name their own files. The ranked
 * "related files" row must not spend a slot naming one of those files again.
 * Its own file, because `vi.mock` applies to the whole test file.
 */

const state = vi.hoisted(() => ({
  facts: undefined as unknown,
  related: [] as unknown[],
  limits: [] as number[],
}));

vi.mock("../explain/facts.js", () => ({ collectFacts: vi.fn(async () => state.facts) }));
vi.mock("../explain/related-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../explain/related-files.js")>()),
  collectRelatedFiles: vi.fn(async (_c: unknown, _t: unknown, _f: unknown, limit: number) => {
    state.limits.push(limit);
    return (state.related as RelatedRef[]).slice(0, limit);
  }),
}));
// No working tree: text references and git history are not what is tested.
vi.mock("../explain/text-references.js", () => ({ collectTextReferences: vi.fn(() => []), gitRepoAccess: vi.fn(() => undefined) }));
vi.mock("../explain/history.js", () => ({
  gitRunner: vi.fn(() => async () => undefined),
  recentCommits: vi.fn(async () => []),
  coChangedFiles: vi.fn(async () => []),
}));

const { collectContextFacts } = await import("../context/collect.js");

const loc = (id: string, name: string, path: string, kind = "class"): EntityLocation => ({ id, name, kind, path });
const file = (n: number): RelatedRef =>
  ({ id: `r-${n}`, name: `f${n}.ts`, kind: "file", path: `src/f${n}.ts`, score: 10 - n, reason: "", via: ["x"] }) as RelatedRef;

function facts(over: Partial<ContextFacts>): ContextFacts {
  return {
    id: "c-target", name: "Service", kind: "class", path: "src/service.ts",
    members: [], memberCount: 0, callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [], historyLength: 0, stale: false, diagnostics: [],
    ...over,
  };
}

const client = {} as IxClient;

describe("related files for a class target", () => {
  beforeEach(() => {
    state.limits = [];
  });

  it("drops the files of the class's bases and field types, and fills the freed slots", async () => {
    state.facts = facts({
      extendsRefs: [loc("t-base", "BaseService", "src/f0.ts")],
      referenceRefs: [loc("t-store", "Store", "src/f2.ts")],
    });
    state.related = Array.from({ length: 12 }, (_, i) => file(i));

    const out = await collectContextFacts(client, { id: "c-target", name: "Service", kind: "class" });

    const paths = (out.relatedRefs ?? []).map((r) => r.path);
    expect(paths).not.toContain("src/f0.ts");
    expect(paths).not.toContain("src/f2.ts");
    // Still eight: two more were asked for, to take the two slots given up.
    expect(paths).toEqual(["src/f1.ts", "src/f3.ts", "src/f4.ts", "src/f5.ts", "src/f6.ts", "src/f7.ts", "src/f8.ts", "src/f9.ts"]);
    expect(state.limits).toEqual([10]);
  });

  it("leaves a target with no type refs exactly as it was", async () => {
    state.facts = facts({ kind: "function" });
    state.related = Array.from({ length: 12 }, (_, i) => file(i));

    const out = await collectContextFacts(client, { id: "c-target", name: "Service", kind: "function" });

    expect((out.relatedRefs ?? []).map((r) => r.id)).toEqual(["r-0", "r-1", "r-2", "r-3", "r-4", "r-5", "r-6", "r-7"]);
    expect(state.limits).toEqual([8]);
  });
});
