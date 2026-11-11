// Copyright 2026 Ix Infrastructure Inc.

// What a cut bundle tells its reader: which evidence was dropped and the
// flag (or MCP argument) that would bring it back.

import { forMcp, suggest } from "../next-step.js";
import { CONTAINER_KINDS } from "../graph-model.js";

import type { EvidenceItem, ContextBundle } from "./types.js";

const CUT_LABELS: Record<string, string> = {
  "issue.starts": "starting points row",
  "issue.ranking": "ranked files row",
  "facts.container": "container",
  "facts.members": "member",
  "facts.imports": "import",
  "facts.callees": "call",
  "facts.neighbours": "neighbouring definition",
  "facts.related": "related file",
  "git.history": "recent commits",
  "facts.callers": "caller",
  "facts.dependents": "dependent",
  "context.claims": "claim",
  "context.decisions": "decision",
  "context.conflicts": "conflict",
  "context.intents": "intent",
  "context.edges": "relationship",
};

/** Group the evidence a budget dropped by category, largest first. */
export function summariseCut(dropped: EvidenceItem[]): Array<{ what: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of dropped) {
    const what = CUT_LABELS[item.source] ?? item.kind;
    counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([what, count]) => ({ what, count }))
    .sort((a, b) => b.count - a.count || a.what.localeCompare(b.what));
}

/**
 * The cheapest command that gets back what the budget dropped.
 *
 * Target-specific because the answer is: a file that lost its own members wants
 * one of those members as a target, not a bigger budget for the file; a symbol
 * that lost callers wants `ix callers`, which is bounded and ranked and costs a
 * fraction of a bundle. `--max-tokens` is named last, as the lever that works
 * for anything and pays for everything.
 */
function cutLever(bundle: ContextBundle, top: { what: string }): string {
  if (forMcp()) return mcpCutLever(bundle, top);
  const name = bundle.target.name;
  const container = CONTAINER_KINDS.has(bundle.target.kind.toLowerCase());
  switch (top.what) {
    case "member":
      return container
        ? `run ix context on one of them, or raise --max-tokens`
        : `ix contains ${name}, or raise --max-tokens`;
    case "caller":
      return `ix callers ${name}, or raise --max-tokens`;
    case "dependent":
      return `ix impact ${name}, or raise --max-tokens`;
    case "import":
      return `ix imports ${name}, or raise --max-tokens`;
    case "call":
      return `ix callees ${name}, or raise --max-tokens`;
    case "relationship":
      return `ix depends ${name}, or raise --max-tokens`;
    case "claim":
    case "conflict":
      return `ix conflicts ${name}, or raise --max-tokens`;
    default:
      return `raise --max-tokens`;
  }
}

/**
 * {@link cutLever} for an MCP caller: only core tools, and `max_tokens` for
 * the budget, since `ix_context` takes no flags. `ix contains`, `ix depends`
 * and `ix conflicts` have no core tool, so those cuts fall back to the nearest
 * one that does exist, or to the budget alone.
 */
function mcpCutLever(bundle: ContextBundle, top: { what: string }): string {
  const { name, path } = bundle.target;
  const container = CONTAINER_KINDS.has(bundle.target.kind.toLowerCase());
  const pin = container ? {} : { path };
  const budget = "raise max_tokens (default 3000)";
  switch (top.what) {
    case "member":
      return container ? `call ix_context on one of them, or ${budget}` : budget;
    case "caller":
      return `${suggest.neighbors(name, "callers", pin)}, or ${budget}`;
    case "dependent":
    case "relationship":
      return `${suggest.impact(name, pin)}, or ${budget}`;
    case "import":
      return `${suggest.neighbors(name, "imports", pin)}, or ${budget}`;
    case "call":
      return `${suggest.neighbors(name, "callees", pin)}, or ${budget}`;
    default:
      return budget;
  }
}

/** One sentence naming what was cut and the cheapest way to get it back. */
export function truncationAdvice(bundle: ContextBundle): string | undefined {
  const cut = bundle.truncation.cut ?? [];
  if (cut.length === 0) return undefined;
  const named = cut
    .slice(0, 3)
    .map((c) => `${c.count} ${c.what}${c.count === 1 ? "" : "s"}`)
    .join(", ");
  return `cut: ${named} — ${cutLever(bundle, cut[0])}`;
}
