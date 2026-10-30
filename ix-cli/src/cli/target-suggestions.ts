// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from "../client/api.js";
import { relativePath } from "./format.js";
import type { Suggestion } from "./resolve.js";

export interface TargetCandidate {
  name: string;
  kind: string;
  path: string | null;
  line: number | null;
}

export interface SuggestOptions {
  suggest?: boolean;
  suggestCommand?: string;
  kind?: string;
  workspaceId?: string;
  systemId?: string;
  fileTarget?: boolean;
}

// At most seven targeted name-index probes, each for a non-empty term: never a
// graph scan, and never an empty term, whose meaning /v1/search leaves open.
export const SUGGEST_MAX_REQUESTS = 7;
export const SUGGEST_MAX_ROWS = 256;
export const SUGGEST_MAX_MS = 100;
const MAX_NAME = 128;
const normalize = (value: string) => value.toLowerCase().replace(/[_\-\s]/g, "");
const slash = (value: string) => value.replace(/\\/g, "/").replace(/^file:\/\//, "");

/** Banded Levenshtein: stop once no edit distance <= 2 remains possible. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(3);
    current[0] = i;
    for (let j = Math.max(1, i - 2); j <= Math.min(b.length, i + 2); j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    }
    previous = current;
  }
  return previous[b.length];
}

/** Suggestions never participate in resolution. All strategies share one deadline. */
export async function findTargetCandidates(
  client: Pick<IxClient, "search">,
  target: string,
  opts: SuggestOptions,
  missMs: number,
): Promise<{ didYouMean: TargetCandidate[]; suggestions?: Suggestion[]; retryCommand?: string }> {
  const budget = Math.min(SUGGEST_MAX_MS, Math.max(0, missMs / 2));
  if (opts.suggest === false || !target || target.length > MAX_NAME || budget <= 0) return { didYouMean: [] };
  const started = performance.now();
  const deadline = started + budget;
  const controller = new AbortController();
  const isPath = opts.fileTarget || /[\\/]/.test(target) || opts.kind === "file";
  const full = slash(target).toLowerCase();
  const bare = (isPath ? full.split("/").pop() : target.split(/::|[.#]/).pop())!.toLowerCase();
  const words = bare.split(/[_-]/).filter(Boolean);
  // Preserve case while splitting camelCase, before lowering the probe terms.
  const parts = target.split(/::|[.#]/).pop()!.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]/);
  const width = Math.max(1, Math.ceil(bare.length / 2));
  const terms = [...new Set([target, bare, ...words.slice(0, 2), ...parts.slice(0, 2), bare.slice(0, width), bare.slice(-width)])]
    .filter(Boolean).slice(0, SUGGEST_MAX_REQUESTS);
  const rowsPerRequest = Math.floor(SUGGEST_MAX_ROWS / terms.length);
  const ranked: Array<{ candidate: TargetCandidate; score: number; id: string }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(); }, budget);
    });
    const probes = terms.map(async (term) => {
      try {
        const nodes = await client.search(term, {
          limit: rowsPerRequest, nameOnly: true, kind: isPath ? "file" : opts.kind,
          workspaceId: opts.workspaceId, systemId: opts.systemId, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        for (const node of nodes.slice(0, rowsPerRequest)) {
          if (performance.now() >= deadline) break;
          const name = String(node.name ?? node.attrs?.name ?? "");
          if (!node.id || !name || name.length > MAX_NAME || ["chunk", "import", "reference"].includes(node.kind)) continue;
          if ((isPath && node.kind !== "file") || (opts.kind && node.kind !== opts.kind)) continue;
          const rawPath = node.provenance?.sourceUri ?? (node.provenance as any)?.source_uri;
          const nodePath = rawPath ? slash(rawPath) : "";
          const lower = name.toLowerCase();
          const targetParts = full.split("/").reverse();
          const nodeParts = nodePath.toLowerCase().split("/").reverse();
          const pathSuffix = isPath && targetParts.length > 1 && nodeParts.length > 1
            && targetParts[0] === nodeParts[0] && targetParts[1] === nodeParts[1];
          let score: number;
          if (pathSuffix || isPath && (full.endsWith(`/${nodePath.toLowerCase()}`) || nodePath.toLowerCase().endsWith(`/${full.replace(/^\.\//, "")}`))) score = 0;
          else if (lower === full) score = 0;
          else if (lower === bare || isPath && nodePath.toLowerCase().split("/").pop() === bare) score = 1;
          else if (normalize(lower) === normalize(bare)) score = 2;
          else if (bare.length >= 3 && (lower.startsWith(bare) || lower.endsWith(bare) || bare.startsWith(lower) || bare.endsWith(lower))) score = 3;
          else {
            const edits = distance(lower, bare);
            if (edits > 2) continue;
            score = 4 + edits / 10;
          }
          const line = Number(node.attrs?.line_start ?? node.attrs?.lineStart ?? (node as any).line_start);
          ranked.push({ score, id: node.id, candidate: { name, kind: node.kind,
            path: rawPath ? relativePath(rawPath) ?? rawPath : null,
            line: Number.isInteger(line) && line > 0 ? line : null } });
        }
      } catch { /* Optional guidance must never replace the original error. */ }
    });
    await Promise.race([Promise.all(probes), expired]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  ranked.sort((a, b) => a.score - b.score || a.candidate.name.localeCompare(b.candidate.name)
    || (a.candidate.path ?? "").localeCompare(b.candidate.path ?? ""));
  const unique = ranked.filter(({ candidate }, i, all) => all.findIndex(({ candidate: other }) =>
    other.name === candidate.name && other.path === candidate.path
      && other.kind === candidate.kind && other.line === candidate.line) === i);
  const didYouMean = unique.slice(0, 5).map(({ candidate }) => candidate);
  const best = unique[0];
  // A whole strategy tier (or the only result) is clear; lexical tie breaks aren't.
  const clear = best && (!unique[1] || unique[1].score - best.score >= 1);
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const retryCommand = clear && best.candidate.path && opts.suggestCommand
    ? `ix ${opts.suggestCommand} ${quote(isPath ? best.candidate.path : best.candidate.name)} --path ${quote(best.candidate.path)}${opts.kind ? ` --kind ${quote(opts.kind)}` : ""}`
    : undefined;
  const suggestions = unique.slice(0, 3).map(({ candidate, id }) => ({
    id, name: candidate.name, kind: candidate.kind, path: candidate.path ?? undefined,
  }));
  return { didYouMean, ...(suggestions.length ? { suggestions } : {}), ...(retryCommand ? { retryCommand } : {}) };
}
