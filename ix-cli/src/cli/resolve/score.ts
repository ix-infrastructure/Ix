// Copyright 2026 Ix Infrastructure Inc.

/**
 * How well a graph node answers a target name. Pure: a score depends only on
 * the node, the name and the caller's filters. Nothing here talks to the
 * backend, reads the environment or prints (resolve-split.test.ts checks), so
 * a ranking can be tested with plain node objects.
 */

import {
  candidateOrigin, isFileStemMatch, looksLikeCodeIdentifier, requestsNonCode,
} from "../candidate-origin.js";
import { normalizeForPathMatch } from "../path-match.js";
import { CONTAINER_KINDS, STRUCTURAL_KINDS } from "../graph-model.js";

/** A PascalCase name, the way a type is usually named. */
export function looksTypeLikeSymbol(symbol: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(symbol);
}

/**
 * Score added to a candidate that shares the name but is not the code
 * definition (see candidate-origin.ts for how each is recognised).
 *
 * - An import entity is a single-line `module`: +5 cancels the -3 container
 *   boost it gets as a `module` and leaves it +2 behind a bare exact match, so
 *   a same-named function (-1), class (-3) or defining file (0) all beat it.
 * - A CSS selector, markdown heading or JSON key (+10, only for a term that
 *   looks like a code identifier and only when the caller did not ask for that
 *   kind or language) and a copy in build output, a fixture or a sample (+10)
 *   land behind the import: an import at least points at the definition. 10
 *   is enough to put even a PascalCase CSS class (-7 with the type boost)
 *   behind a same-named function (-1).
 *
 * A demotion, never a filter — when nothing else shares the name these are
 * still the best (and only) answer.
 */
export function originPenalty(
  node: any,
  symbol: string,
  opts?: { kind?: string; language?: string },
): number {
  switch (candidateOrigin(node)) {
    case "import": return 5;
    case "generated": return 10;
    case "non-code": return looksLikeCodeIdentifier(symbol) && !requestsNonCode(opts) ? 10 : 0;
    default: return 0;
  }
}

/**
 * Score a candidate node for resolution.
 * Lower is better. Combines:
 *   - exact name match (0), defining-file stem match (3), prefix (15), other (30)
 *   - exact kind match when --kind provided (-5)
 *   - strong path match when --path provided (-4)
 *   - structural kind boost (-3 for container, -1 for method/function)
 *   - penalty for an import / non-code / generated candidate (originPenalty)
 */
export function scoreCandidate(
  node: any,
  symbol: string,
  opts?: { kind?: string; path?: string; language?: string }
): number {
  return baseScore(node, symbol, opts) + originPenalty(node, symbol, opts);
}

/** `scoreCandidate` without the origin penalty: how well the NAME matched. */
export function baseScore(
  node: any,
  symbol: string,
  opts?: { kind?: string; path?: string }
): number {
  const name: string = (node.name || node.attrs?.name || "").toLowerCase();
  const kind: string = (node.kind || "").toLowerCase();
  const symbolLower = symbol.toLowerCase();
  const sourceUri = normalizeForPathMatch(node.provenance?.sourceUri ?? node.provenance?.source_uri ?? "");

  let score = 50; // baseline

  // ── Name match ──────────────────────────────────────────────────────
  if (name === symbolLower) {
    score = 0; // exact name match — best tier
  } else if (isFileStemMatch(node, symbol)) {
    // `borderStylesReset.js` for `borderStylesReset`: the file is the
    // definition of an anonymous default export. Behind a same-named symbol
    // (a function nets -1, this nets 0), ahead of an import of it (+2).
    score = 3;
  } else if (name.startsWith(symbolLower)) {
    score = 15; // prefix match — moderate
  } else {
    score = 30; // fuzzy / incidental — poor
  }

  // ── Kind match ──────────────────────────────────────────────────────
  if (opts?.kind && kind === opts.kind.toLowerCase()) {
    score -= 5; // exact kind requested by user
  }

  // ── Structural boost ────────────────────────────────────────────────
  if (CONTAINER_KINDS.has(kind)) {
    score -= 3; // containers are high-value resolution targets
  } else if (STRUCTURAL_KINDS.has(kind)) {
    score -= 1; // methods/functions are useful but lower than containers
  } else if (kind === "chunk") {
    score += 5; // chunks are retrieval units, not useful as trace starting points
  }
  // non-structural kinds (config_entry, doc, decision, etc.) get no boost

  if (looksTypeLikeSymbol(symbol) && name === symbolLower) {
    if (kind === "class" || kind === "interface" || kind === "trait" || kind === "object") {
      score -= 4;
    }
    // No penalty for method/function: the +3 that was here caused chunks (score=0)
    // to outscore structural entities (function/method net score=2) for PascalCase
    // names like "Apply", "StartEtcd", "Range". Chunks are now penalised explicitly above.
  }

  // ── Path match ──────────────────────────────────────────────────────
  if (opts?.path) {
    const pathLower = normalizeForPathMatch(opts.path);
    if (sourceUri.includes(pathLower)) {
      // Specificity bonus: a longer/more specific filter string gives a larger
      // score reduction, breaking ties when many entities share the same short
      // path prefix (e.g. 8 structs named Handle all under "tokio/").
      const specificityRatio = pathLower.length / Math.max(sourceUri.length, 1);
      score -= 4 + Math.round(specificityRatio * 6); // bonus from 4 to 10
    }
  }

  return score;
}

/**
 * True when some candidate is a code definition named `symbol` (or its defining file).
 *
 * Code kinds only: `candidateOrigin` calls anything it cannot place a
 * definition, and that includes the `region` nodes `ix map` names after
 * directories and modules (`Format`, `Search`, `CLI`, provenance `ix:map`).
 * Counting one would skip the lookup for the file that defines the name.
 */
export function hasDefinitionOf(nodes: any[], symbol: string): boolean {
  const symbolLower = symbol.toLowerCase();
  return nodes.some((n: any) => {
    const name = String(n.name || n.attrs?.name || "").toLowerCase();
    const sourceUri = String(n.provenance?.sourceUri ?? n.provenance?.source_uri ?? "");
    return (name === symbolLower || isFileStemMatch(n, symbol))
      && STRUCTURAL_KINDS.has(String(n.kind || "").toLowerCase())
      && !sourceUri.startsWith("ix:")
      && candidateOrigin(n) === "definition";
  });
}
