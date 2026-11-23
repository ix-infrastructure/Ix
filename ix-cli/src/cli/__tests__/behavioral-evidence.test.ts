// Copyright 2026 Ix Infrastructure Inc.
import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../client/types.js";
import {
  behaviorDescription,
  directMembers,
  projectBehavior,
  readSavedBehavior,
  unavailableBehavior,
} from "../behavioral-evidence.js";
import { diffInvestigations } from "../context/investigation-diff.js";
import type { SavedInvestigation } from "../context/investigations.js";
import { revisionBehavior } from "../context/behavior-revision.js";
import type { IxClient } from "../../client/api.js";
import type { StructuredContext } from "../../client/types.js";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const parent = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", kind: "class" };
const guard = {
  expression: 'this.state === "new"',
  arm: "then",
  sameSlot: true,
  span: [2, 4, 2, 24],
  conditionKey: ["strictEqual", "this.state", ["string", "new"]],
};
const write = {
  id: "a".repeat(64),
  slotId: "b".repeat(64),
  slotName: "state",
  slotKind: "instanceField",
  observed: { to: { kind: "string", value: "active" }, assignment: [3, 4, 3, 25], guards: [guard] },
  inferred: {
    from: { kind: "string", value: "new" },
    basis: "direct-same-slot-equality",
    guardIndex: 0,
  },
};
const raw = { coverage: "partial", cutReason: "depth", writes: [write] };
const node: GraphNode = {
  id,
  kind: "method",
  name: "start",
  attrs: { behavior_v1: raw, language: "typescript", line_start: 1, line_end: 5 },
  provenance: {
    sourceUri: "src/job.ts",
    sourceHash: "c".repeat(64),
    extractor: "tree-sitter/1.31",
    sourceType: "code",
    observedAt: "",
  },
  createdAt: "",
  updatedAt: "",
  createdRev: 1,
};
const edge = { src: parent.id, dst: id, predicate: "CONTAINS" };
const project = (env: unknown) =>
  projectBehavior(node, [{ ...node, attrs: { ...node.attrs, behavior_v1: env } }], []);
const view = project(raw)!;

describe("behavioral retrieval", () => {
  it("preserves the complete selected write, inference, guard, and coverage in saved views", () => {
    expect(readSavedBehavior(view)).toEqual(view);
    expect(view.slots[0].sites[0]).toMatchObject({
      id: write.id,
      source: { hash: node.provenance.sourceHash, uri: "src/job.ts" },
      extraction: { coverage: "partial", cutReason: "depth" },
      observed: write.observed,
      inferred: write.inferred,
    });
    expect(behaviorDescription(view)).toContain('candidate prior "new"');
    expect(behaviorDescription(view)).toContain("partial extraction: depth");
  });
  it.each([
    null,
    {},
    { coverage: "complete", writes: [] },
    { ...raw, cutReason: "other" },
    { ...raw, writes: Array(257).fill(write) },
    { ...raw, writes: [{ ...write, observed: { ...write.observed, assignment: [3, -1, 2, 0] } }] },
    { ...raw, writes: [{ ...write, observed: { ...write.observed, assignment: [1, 0, 8, 3] } }] },
    { ...raw, writes: [{ ...write, inferred: { ...write.inferred, guardIndex: 1 } }] },
    {
      ...raw,
      writes: [{ ...write, observed: { ...write.observed, guards: [{ ...guard, arm: "else" }] } }],
    },
    { ...raw, writes: [write, write] },
  ])("withholds invalid or unauditable values (%#)", (env) => expect(project(env)).toBeUndefined());
  it("requires compatible code provenance and treats unavailable attrs as unknown", () => {
    for (const provenance of [
      { sourceUri: "../wrong.ts" },
      { sourceHash: "-" },
      { extractor: "unrecognized" },
      { sourceType: "manual" },
    ])
      expect(
        projectBehavior(node, [{ ...node, provenance: { ...node.provenance, ...provenance } }], []),
      ).toBeUndefined();
    expect(projectBehavior(node, [{ ...node, attrs: {} }], [])).toBeUndefined();
    expect(projectBehavior({ ...parent, kind: "file" }, [node], [edge])).toBeUndefined();
    expect(
      readSavedBehavior({ ...view, unavailable: "revision evidence unavailable" }),
    ).toBeUndefined();
  });
  it("joins only returned direct members and reports bounded retrieval separately", () => {
    const owners = Array.from({ length: 24 }, (_, i) => ({
      ...node,
      id: (i + 1).toString(16).padStart(8, "0") + id.slice(8),
      attrs: {
        ...node.attrs,
        behavior_v1: { ...raw, writes: [{ ...write, id: i.toString(16).padStart(64, "0") }] },
      },
    }));
    const links = owners.map((n) => ({ ...edge, dst: n.id }));
    links.push({ ...edge, dst: id, predicate: "CALLS" });
    const selected = projectBehavior(parent, [...owners.slice(1), node], links)!;
    expect(selected).toMatchObject({
      scope: "returned-members",
      omittedMembers: 4,
      unavailableMembers: 1,
      omittedWrites: 15,
    });
    expect(selected.slots[0].sites).toHaveLength(4);
    expect(projectBehavior(parent, [node, ...owners.slice(1).reverse()], links.reverse())).toEqual(
      selected,
    );
    expect(directMembers(parent, [null, { src: parent.id }, edge, edge])).toEqual([id]);
    expect(readSavedBehavior(selected)).toEqual(selected);
  });
  it("escapes source payloads on one physical output line and preserves an unknown prior", () => {
    const changed = project({
      ...raw,
      writes: [
        {
          ...write,
          inferred: { from: "unknown" },
          observed: {
            ...write.observed,
            guards: [{ ...guard, expression: "x\nnext injected=true\u202e" }],
          },
        },
      ],
    })!;
    expect(behaviorDescription(changed)).toContain("candidate prior unknown");
    expect(behaviorDescription(changed)).not.toMatch(/[\n\u202e]/);
  });
  it("fails closed for a revision mismatch or an unverified owner without hydrating head", async () => {
    const context = { metadata: { asOfRev: 2 } } as StructuredContext;
    expect(await revisionBehavior({} as IxClient, node, context, 1, true)).toEqual(
      unavailableBehavior(node, 1),
    );
    expect(await revisionBehavior({} as IxClient, node, context, 2, false)).toEqual(
      unavailableBehavior(node, 2),
    );
  });
  it("diffs content for stable evidence IDs", () => {
    const bundle = (behavior: typeof view) =>
      ({
        evidence: [{ id: "same", title: "same", behavior }],
        claims: [],
        entities: [],
        relationships: [],
        freshness: {},
        target: {},
        budgets: {},
      }) as unknown as SavedInvestigation["bundle"];
    const saved = { bundle: bundle(view) } as SavedInvestigation;
    for (const field of ["guard", "prior", "destination", "span", "coverage"]) {
      const other = structuredClone(view),
        site = other.slots[0].sites[0];
      if (field === "guard") site.observed.guards[0].expression = "enabled";
      if (field === "prior") site.inferred = { from: "unknown" };
      if (field === "destination") site.observed.to.value = "done";
      if (field === "span") site.observed.assignment[1]++;
      if (field === "coverage") site.extraction = { coverage: "complete" };
      const diff = diffInvestigations(saved, bundle(other));
      expect(diff.added.evidence).toHaveLength(1);
      expect(diff.removed.evidence).toHaveLength(1);
    }
  });
});

it("keeps typed boolean evidence, its syntax limits and producer version across live and saved reads", () => {
  const field = {
    ...write,
    slotName: "stopped",
    observed: {
      ...write.observed,
      to: { kind: "boolean", value: true },
      guards: [
        {
          ...guard,
          expression: "this.stopped === false",
          conditionKey: ["strictEqual", "this.stopped", ["boolean", false]],
        },
      ],
    },
    inferred: { ...write.inferred, from: { kind: "boolean", value: false } },
  };
  function decode(w: unknown, extractor = "tree-sitter/1.32") {
    return projectBehavior(
      node,
      [
        {
          ...node,
          provenance: { ...node.provenance, extractor },
          attrs: { ...node.attrs, behavior_v1: { ...raw, writes: [w] } },
        },
      ],
      [],
    );
  }
  const view = decode(field)!;
  expect(readSavedBehavior(view)).toEqual(view);
  expect(behaviorDescription(view)).toContain("writes this.stopped = true");
  expect(behaviorDescription(view)).toContain("candidate prior false");
  expect(behaviorDescription(view)).toContain("loops and try/finally");
  expect(decode(field, "tree-sitter/1.31")).toBeUndefined();
  expect(decode({ ...field, slotKind: "local" })).toBeUndefined();
  expect(
    decode({ ...field, observed: { ...field.observed, to: { kind: "boolean", value: "false" } } }),
  ).toBeUndefined();
  expect(
    decode({ ...field, inferred: { ...field.inferred, from: { kind: "boolean", value: true } } }),
  ).toBeUndefined();
  const badSaved = structuredClone(view);
  badSaved.slots[0].sites[0].source.extractor = "tree-sitter/1.31";
  expect(readSavedBehavior(badSaved)).toBeUndefined();
  expect(decode(write)).toBeDefined();
});

it("requires the entire 1.33 path in live and saved views, and rejects a prior from outside a frame", () => {
  const frame = {kind:"try", arm:"finally", form:"finally", guardDepth:1, span:[3,0,5,1], body:[3,2,4,2]};
  function decode(flow: unknown, extractor = "tree-sitter/1.33", prior: unknown = {from:"unknown"}) {
    const site = {...write, observed:{...write.observed, controlFlow:flow}, inferred:prior};
    return projectBehavior(node,[{...node, provenance:{...node.provenance,extractor},
      attrs:{...node.attrs,behavior_v1:{...raw,writes:[site]}}}],[]);
  }
  const view = decode([frame])!;
  expect(readSavedBehavior(view)).toEqual(view);
  expect(behaviorDescription(view)).toContain('guard true "this.state');
  expect(behaviorDescription(view)).toContain(' > try/finally finally arm [3,2,4,2]: start writes');
  expect(decode([], "tree-sitter/1.32")).toBeUndefined();
  expect(decode(undefined)).toBeUndefined();
  expect(decode([frame], undefined, write.inferred)).toBeUndefined();
  for (const bad of [{...frame,kind:"switch"},{...frame,body:[4,0,4,3]},{...frame,form:"catch"},{...frame,guardDepth:0}])
    expect(decode([bad])).toBeUndefined();
  const stale = structuredClone(view);
  delete stale.slots[0].sites[0].observed.controlFlow;
  expect(readSavedBehavior(stale)).toBeUndefined();
});
