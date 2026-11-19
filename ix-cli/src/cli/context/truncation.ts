// Copyright 2026 Ix Infrastructure Inc.

// What a cut bundle tells its reader: which evidence was dropped and the
// flag (or MCP argument) that would bring it back.

import { currentCaller, type Hint } from "../next-step.js";
import { CONTAINER_KINDS } from "../graph-model.js";

import type { EvidenceItem, ContextBundle } from "./types.js";

const CUT_LABELS: Record<string, string> = {
  "issue.starts": "starting points row",
  "issue.ranking": "ranked files row",
  "facts.container": "container",
  "facts.behavior": "behavioral evidence",
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
  const caller = currentCaller();
  const { name, path } = bundle.target;
  const container = CONTAINER_KINDS.has(bundle.target.kind.toLowerCase());
  // Pins the target's file over MCP; the CLI forms never carried a path.
  const pin = container ? undefined : path;
  const budget = `raise ${caller.lever("max_tokens") ?? "the token budget"}`;
  if (top.what === "member" && container) {
    const context = caller.command({ action: "context" });
    if (!context) return budget;
    return `${caller.style === "tool" ? "call" : "run"} ${context} on one of them, or ${budget}`;
  }
  // The steps that get the cut back, in order of preference; the first the
  // reader can run is named. `ix contains`, `ix depends` and `ix conflicts`
  // have no core MCP tool, so a core session falls back to the nearest one
  // that does exist, or to the budget alone.
  const steps: Hint[] = (() => {
    switch (top.what) {
      case "member":
        return [{ action: "contains", symbol: name }];
      case "caller":
        return [{ action: "neighbors", symbol: name, relation: "callers", path: pin }];
      case "dependent":
        return [{ action: "impact", target: name, path: pin }];
      case "import":
        return [{ action: "neighbors", symbol: name, relation: "imports", path: pin }];
      case "call":
        return [{ action: "neighbors", symbol: name, relation: "callees", path: pin }];
      case "relationship":
        return [{ action: "depends", symbol: name }, { action: "impact", target: name, path: pin }];
      case "claim":
      case "conflict":
        return [{ action: "conflicts", symbol: name }];
      default:
        return [];
    }
  })();
  for (const step of steps) {
    const command = caller.command(step);
    if (command !== undefined) return `${command}, or ${budget}`;
  }
  return budget;
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
