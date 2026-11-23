// Copyright 2026 Ix Infrastructure Inc.
import { createRequire } from "node:module";
import type * as Zod from "zod";
import type { GraphNode } from "../client/types.js";
import { llmLine } from "./llm.js";

export const MAX_BEHAVIOR_MEMBERS = 20;
const MAX_SITES = 4;
const MAX_DECODE_WRITES = 256;
const MAX_DESCRIPTION_CHARS = 1600;
const booleanScope =
  "Direct method and if-block writes only; loops and try/finally are outside extraction scope";
const flowScope = "Lexical sites only; execution and frequency unknown";
const stringSlots = new Set(["state", "phase", "status"]);
const hash = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cleanName = (s: string) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(s);
const callable = (kind: string) => kind === "function" || kind === "method";
export const behaviorTarget = (kind: string) => callable(kind) || kind === "class";
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function schemas(z: typeof Zod.z) {
  const ident = z.string().regex(hash);
  const pos = z
    .number()
    .int()
    .nonnegative()
    .max(2 ** 31 - 1);
  const span = z
    .tuple([pos, pos, pos, pos])
    .refine(([l, c, e, d]) => l >= 1 && (e > l || (e === l && d > c)));
  const literal = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("string"), value: z.string().max(128) }),
    z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  ]);
  const guard = z.object({
    expression: z.string().min(1).max(1024),
    span,
    arm: z.enum(["then", "else"]),
    sameSlot: z.boolean().nullable(),
    conditionKey: z.union([
      z.tuple([
        z.literal("strictEqual"),
        z.string().max(256),
        z.union([
          z.tuple([z.literal("string"), z.string().max(128)]),
          z.tuple([z.literal("boolean"), z.boolean()]),
        ]),
      ]),
      z.tuple([z.literal("tokens"), ident]),
    ]),
  });
  const coverage = z.discriminatedUnion("coverage", [
    z.object({ coverage: z.literal("complete") }),
    z.object({
      coverage: z.literal("partial"),
      cutReason: z.enum([
        "visits",
        "depth",
        "writes",
        "bytes",
        "deadline",
        "conditionLength",
        "literalLength",
        "unavailable",
      ]),
    }),
  ]);
  const frameBase = { span, body: span, guardDepth: pos.max(48) };
  const frame = z.discriminatedUnion("kind", [
    z.object({ ...frameBase, kind: z.enum(["while", "for"]), header: span, headerKey: ident,
      test: z.object({ expression: z.string().min(1).max(1024), span }).nullable() }).strict(),
    z.object({ ...frameBase, kind: z.literal("try"), arm: z.enum(["body", "catch", "finally"]),
      form: z.enum(["catch", "finally", "catchFinally"]) }).strict(),
  ]);
  const observed = z.object({ to: literal, assignment: span, guards: z.array(guard).max(48),
    controlFlow: z.array(frame).max(48).optional() });
  const inferred = z.union([
    z.object({ from: z.literal("unknown") }),
    z.object({
      from: literal,
      basis: z.literal("direct-same-slot-equality"),
      guardIndex: z.number().int().nonnegative(),
    }),
  ]);
  const slot = z.object({
    slotId: ident,
    slotKind: z.enum(["local", "instanceField"]),
    slotName: z.enum([
      "state",
      "phase",
      "status",
      "stopped",
      "dead",
      "destroyed",
      "queued",
      "running",
    ]),
  });
  const write = slot.extend({ id: ident, observed, inferred }).refine((w) => {
    const { controlFlow, assignment, guards } = w.observed;
    if (controlFlow?.length) {
      const before = (a: number[], i: number, b: number[], j: number) =>
        a[i] < b[j] || (a[i] === b[j] && a[i + 1] <= b[j + 1]);
      const contains = (a: number[], b: number[]) => before(a, 0, b, 0) && before(b, 2, a, 2);
      if (controlFlow.length + guards.length > 48) return false;
      for (const [i, f] of controlFlow.entries()) {
        const outer = controlFlow[i - 1];
        if (!contains(f.span, f.body) || !contains(f.body, assignment) ||
            f.guardDepth > guards.length || (outer && (!contains(outer.body, f.span) ||
              f.guardDepth < outer.guardDepth || !before(outer.span, 0, f.span, 0) ||
              (outer.span[0] === f.span[0] && outer.span[1] === f.span[1])))) return false;
        if (guards.some((g, j) => j < f.guardDepth ? !before(g.span, 2, f.span, 0) :
          !contains(f.body, g.span) || !before(g.span, 2, assignment, 0))) return false;
        if (f.kind === "try") {
          if (f.arm !== "body" && f.form !== "catchFinally" && f.arm !== f.form) return false;
        } else if (!contains(f.span, f.header) || f.header[0] !== f.span[0] || f.header[1] !== f.span[1] ||
                   !before(f.header, 2, f.body, 0) || (f.test ? !contains(f.header, f.test.span) : f.kind === "while")) return false;
      }
      if (w.inferred.from !== "unknown" && w.inferred.guardIndex < controlFlow.at(-1)!.guardDepth) return false;
    }
    const boolean = w.observed.to.kind === "boolean";
    if (boolean === stringSlots.has(w.slotName) || (boolean && w.slotKind !== "instanceField"))
      return false;
    const operand = (w.slotKind === "local" ? "" : "this.") + w.slotName;
    if (
      w.observed.guards.some(
        (g) =>
          g.conditionKey[0] === "strictEqual" &&
          (g.conditionKey[2][0] !== w.observed.to.kind ||
            g.sameSlot !== (g.conditionKey[1] === operand)),
      )
    )
      return false;
    if (w.inferred.from === "unknown") return true;
    const g = w.observed.guards[w.inferred.guardIndex];
    return (
      w.inferred.guardIndex === w.observed.guards.length - 1 &&
      g?.arm === "then" &&
      g.sameSlot === true &&
      g.conditionKey[0] === "strictEqual" &&
      g.conditionKey[1] === (w.slotKind === "local" ? w.slotName : "this." + w.slotName) &&
      g.conditionKey[2][0] === w.inferred.from.kind &&
      g.conditionKey[2][1] === w.inferred.from.value
    );
  });
  const source = z.object({
    uri: z
      .string()
      .min(1)
      .max(2048)
      .refine(
        (s) =>
          s.length <= 2048 &&
          cleanName(s) &&
          !s.startsWith("/") &&
          !s.includes("\\") &&
          !s.split("/").includes("..") &&
          !/^[\w+.-]+:/.test(s),
      ),
    hash: ident,
    extractor: z.enum(["tree-sitter/1.31", "tree-sitter/1.32", "tree-sitter/1.33"]),
  });
  const site = z.object({
    id: ident,
    ownerId: z.string().regex(uuid),
    ownerName: z.string().min(1).max(512).refine(cleanName),
    source,
    extraction: coverage,
    syntaxScope: z.enum([booleanScope, flowScope]).optional(),
    observed,
    inferred,
  });
  const view = z
    .object({
      revision: z.number().int().positive().optional(),
      scope: z.enum(["target", "returned-members"]),
      unavailable: z.literal("revision evidence unavailable").optional(),
      unavailableMembers: pos,
      omittedMembers: pos,
      omittedWrites: pos,
      slots: z.array(slot.extend({ sites: z.array(site).min(1).max(MAX_SITES) })).max(MAX_SITES),
    })
    .refine(
      (v) =>
        v.slots.reduce((n, s) => n + s.sites.length, 0) <= MAX_SITES &&
        (!v.unavailable || (v.revision !== undefined && v.slots.length === 0)) &&
        new Set(v.slots.map((s) => s.slotId)).size === v.slots.length &&
        new Set(v.slots.flatMap((s) => s.sites.map((w) => w.id))).size ===
          v.slots.reduce((n, s) => n + s.sites.length, 0) &&
        v.slots.every((s) =>
          s.sites.every(
            (w) =>
              write.safeParse({ ...s, ...w }).success &&
              producerMatches(w.source.extractor, w.observed) &&
              w.syntaxScope === scopeFor(w.source.extractor, w.observed.to.kind),
          ),
        ),
    );
  return { write, coverage, source, view };
}

const requireZod = createRequire(import.meta.url);
let built: ReturnType<typeof schemas> | undefined;
function schema() {
  return (built ??= schemas((requireZod("zod") as typeof Zod).z));
}
export type BehaviorView = Zod.infer<ReturnType<typeof schemas>["view"]>;
type Slot = BehaviorView["slots"][number];
type Site = Slot["sites"][number];

function producerMatches(producer: string, observed: {to: {kind: string}; controlFlow?: unknown}): boolean {
  return (producer === "tree-sitter/1.33") === (observed.controlFlow !== undefined) &&
    (producer !== "tree-sitter/1.31" || observed.to.kind === "string");
}

function scopeFor(producer: string, literal: string) {
  if (producer === "tree-sitter/1.33") return flowScope;
  return literal === "boolean" ? booleanScope : undefined;
}

function guardedArray(raw: unknown, max: number): raw is unknown[] {
  return Array.isArray(raw) && raw.length <= max;
}

// Bound work before schema validation (array validators may visit every entry even on a failed length check).
function boundedSite(w: unknown): boolean {
  return (
    record(w) &&
    record(w.observed) &&
    (w.observed.controlFlow === undefined || (guardedArray(w.observed.controlFlow, 48) &&
      w.observed.controlFlow.every(f => record(f) && guardedArray(f.span, 4) && guardedArray(f.body, 4) &&
        (f.kind === "try" || (guardedArray(f.header, 4) &&
          (f.test === null || (record(f.test) && guardedArray(f.test.span, 4)))))))) &&
    guardedArray(w.observed.assignment, 4) &&
    guardedArray(w.observed.guards, 48) &&
    w.observed.guards.every(
      (g) =>
        record(g) &&
        guardedArray(g.span, 4) &&
        guardedArray(g.conditionKey, 3) &&
        (g.conditionKey.length < 3 || guardedArray(g.conditionKey[2], 2)),
    )
  );
}

export function readSavedBehavior(value: unknown): BehaviorView | undefined {
  if (
    !record(value) ||
    !guardedArray(value.slots, MAX_SITES) ||
    !value.slots.every(
      (s) => record(s) && guardedArray(s.sites, MAX_SITES) && s.sites.every(boundedSite),
    )
  )
    return undefined;
  return schema().view.safeParse(value).data;
}

type Target = { id: string; kind: string; provenance?: GraphNode["provenance"] };
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function directMembers(target: Target, edges: unknown[]): string[] {
  const children = new Set<string>();
  for (const edge of edges) {
    if (
      record(edge) &&
      edge.src === target.id &&
      edge.predicate === "CONTAINS" &&
      typeof edge.dst === "string"
    )
      children.add(edge.dst);
  }
  return [...children].sort(order);
}

function emptyView(target: Target, revision?: number): BehaviorView {
  return {
    ...(revision === undefined ? {} : { revision }),
    scope: target.kind === "class" ? "returned-members" : "target",
    unavailableMembers: 0,
    omittedMembers: 0,
    omittedWrites: 0,
    slots: [],
  };
}
export function unavailableBehavior(target: Target, revision: number): BehaviorView {
  return { ...emptyView(target, revision), unavailable: "revision evidence unavailable" };
}

/** Only the caller chooses a revision. All member joins stay inside its selected graph slice. */
export function projectBehavior(
  target: Target,
  nodes: GraphNode[],
  edges: unknown[],
  revision?: number,
): BehaviorView | undefined {
  if (!behaviorTarget(target.kind)) return undefined;
  const members = target.kind === "class";
  // Most target reads have no envelope. Avoid loading validators or copying the structural neighborhood.
  if (members && !nodes.some((n) => n.attrs?.behavior_v1 !== undefined)) return undefined;
  if (
    !members &&
    !nodes.some(
      (n) => n.id === target.id && n.kind === target.kind && n.attrs?.behavior_v1 !== undefined,
    )
  )
    return undefined;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const owners = members
    ? directMembers(target, edges).filter((id) => !byId.has(id) || callable(byId.get(id)!.kind))
    : [target.id];
  const view = emptyView(target, revision);
  view.omittedMembers = Math.max(0, owners.length - MAX_BEHAVIOR_MEMBERS);
  const slots = new Map<string, Slot>();
  const knownIds = new Set<string>();
  let shown = 0;
  let remaining = MAX_DECODE_WRITES;
  let remainingChars = MAX_DESCRIPTION_CHARS;
  for (const id of owners.slice(0, MAX_BEHAVIOR_MEMBERS)) {
    const n = byId.get(id);
    const raw = n?.attrs?.behavior_v1;
    if (
      !n ||
      !callable(n.kind) ||
      !uuid.test(id) ||
      typeof n.name !== "string" ||
      !n.name ||
      n.name.length > 512 ||
      !cleanName(n.name) ||
      (n.attrs?.language !== "typescript" && n.attrs?.language !== "javascript") ||
      !record(raw) ||
      !guardedArray(raw.writes, 256) ||
      !raw.writes.length
    ) {
      view.unavailableMembers++;
      continue;
    }
    if (raw.writes.length > remaining) {
      view.omittedMembers++;
      continue;
    }
    remaining -= raw.writes.length;
    const p = n.provenance as unknown;
    const source =
      record(p) &&
      schema().source.safeParse({
        uri: p.sourceUri ?? p.source_uri,
        hash: p.sourceHash ?? p.source_hash,
        extractor: p.extractor,
      }).data;
    if (
      members &&
      target.provenance &&
      source &&
      (source.uri !== (target.provenance.sourceUri ?? target.provenance.source_uri) ||
        source.hash !== target.provenance.sourceHash)
    ) {
      view.unavailableMembers++;
      continue;
    }
    const extraction = schema().coverage.safeParse(raw).data;
    if (
      !source ||
      !extraction ||
      (p.sourceType ?? p.source_type) !== "code" ||
      !raw.writes.every(boundedSite)
    ) {
      view.unavailableMembers++;
      continue;
    }
    const writes = raw.writes.map((w) => schema().write.safeParse(w).data);
    const { line_start: first, line_end: last } = n.attrs;
    if (
      writes.some(
        (w) =>
          !w ||
          !producerMatches(source.extractor, w.observed) ||
          (typeof first === "number" &&
            typeof last === "number" &&
            [w.observed.assignment, ...w.observed.guards.map((g) => g.span), ...(w.observed.controlFlow ?? []).map(f => f.span)].some(
              (s) => s[0] < first || s[2] > last,
            )),
      )
    ) {
      view.unavailableMembers++;
      continue;
    }
    for (const w of writes) {
      if (!w) continue;
      // A contradictory graph cannot support a combined machine.
      if (knownIds.has(w.id)) return undefined;
      knownIds.add(w.id);
      const existing = slots.get(w.slotId);
      if (
        existing &&
        (existing.slotName !== w.slotName ||
          existing.slotKind !== w.slotKind ||
          (w.slotKind === "local" && existing.sites[0].ownerId !== id))
      )
        return undefined;
      if (shown >= MAX_SITES) {
        view.omittedWrites++;
        continue;
      }
      const slot = existing ?? {
        slotId: w.slotId,
        slotName: w.slotName,
        slotKind: w.slotKind,
        sites: [],
      };
      const site: Site = {
        id: w.id,
        ownerId: id,
        ownerName: n.name,
        source,
        extraction,
        observed: w.observed,
        inferred: w.inferred,
        ...(scopeFor(source.extractor, w.observed.to.kind) && { syntaxScope: scopeFor(source.extractor, w.observed.to.kind) }),
      };
      const single = { ...view, slots: [{ ...slot, sites: [site] }] };
      const size = behaviorDescription(single).length;
      if (size > remainingChars) {
        view.omittedWrites++;
        continue;
      }
      remainingChars -= size;
      slot.sites.push(site);
      slots.set(w.slotId, slot);
      shown++;
    }
  }
  view.slots = [...slots.values()].sort((a, b) => order(a.slotId, b.slotId));
  return shown || view.omittedWrites || view.omittedMembers ? view : undefined;
}

// Quote source as data on one physical line, including C1 and bidirectional controls.
const quote = (s: string | boolean) =>
  JSON.stringify(s).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
export function behaviorDescription(view: BehaviorView): string {
  if (view.unavailable) return `behavioral evidence unavailable at revision ${view.revision}`;
  const lines: string[] = [];
  for (const slot of view.slots) {
    const name = (slot.slotKind === "instanceField" ? "this." : "") + slot.slotName;
    for (const w of slot.sites) {
      const guards = w.observed.guards.map(
        (g) => `guard ${g.arm === "then" ? "true" : "false"} ${quote(g.expression)} [${g.span}]`,
      );
      const path: string[] = [];
      const frames = w.observed.controlFlow ?? [];
      if (frames.length) for (let depth = 0; depth <= guards.length; depth++) {
        for (const f of frames.filter(f => f.guardDepth === depth)) {
          if (f.kind === "try") {
            const construct = f.form === "catchFinally" ? "try/catch/finally" : "try/" + f.form;
            path.push(`${construct} ${f.arm === "body" ? "body" : f.arm + " arm"} [${f.body}]`);
          } else path.push(`${f.kind} body (test ${f.test ? quote(f.test.expression) : "omitted"}) [${f.header}]`);
        }
        if (depth < guards.length) path.push(guards[depth]);
      }
      lines.push(
        (path.length ? "Inside " + path.join(" > ") + ": " : "") +
        `${w.ownerName} writes ${name} = ${quote(w.observed.to.value)} in ${quote(w.source.uri)} [${w.observed.assignment}]` +
          (!frames.length && guards.length ? ", " + guards.join(", ") : "") +
          `, candidate prior ${w.inferred.from === "unknown" ? "unknown" : quote(w.inferred.from.value)}` +
          (w.extraction.coverage === "partial"
            ? ` (partial extraction: ${w.extraction.cutReason})`
            : ""),
      );
    }
  }
  for (const scope of [booleanScope, flowScope])
    if (view.slots.some(slot => slot.sites.some(site => site.syntaxScope === scope))) lines.push(scope);
  if (view.scope === "returned-members") lines.push("class view covers returned members only");
  if (view.unavailableMembers) lines.push(`${view.unavailableMembers} owner(s) unavailable`);
  if (view.omittedMembers || view.omittedWrites)
    lines.push(`omitted members=${view.omittedMembers} writes=${view.omittedWrites}`);
  if (view.revision !== undefined) lines.push(`revision ${view.revision}`);
  return lines.join(". ");
}
export const behaviorLine = (v: BehaviorView) =>
  llmLine("mapped_writes", { evidence: behaviorDescription(v) });
