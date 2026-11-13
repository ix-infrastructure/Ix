// Copyright 2026 Ix Infrastructure Inc.

import { relativePath } from "./format.js";
import { resolveWorkspaceRoot } from "./config.js";
import { coupledFor, readCoupling } from "./git-coupling.js";
import { llmLine } from "./llm.js";

export function targetCoupling(
  target: { id?: string; path?: string; name: string; kind: string },
  limit = 20,
) {
  const index = readCoupling(resolveWorkspaceRoot());
  if (!index) return undefined;
  return coupledFor(
    index,
    {
      id: target.id,
      path: relativePath(target.path) ?? "",
      ...(target.kind === "file" ? {} : { name: target.name }),
    },
    limit,
  );
}

export function couplingLines(result: ReturnType<typeof targetCoupling>, format: string): string[] {
  if (!result) return [];
  if (format === "llm")
    return [
      llmLine("coupling", [
        ["label", "Changes together"],
        ["mined_head", result.minedHead],
        ["count", result.partners.length],
      ]),
      ...result.partners.map((p) =>
        llmLine("co_change", [
          ["path", p.path],
          ["name", p.name],
          ["support", p.support],
          ["confidence", p.confidence],
          ["last_co_change", p.lastCoChange],
        ]),
      ),
      ...result.recentFixes.map((c) =>
        llmLine("recent_fix", [
          ["sha", c.sha],
          ["date", c.date],
          ["subject", c.subject],
        ]),
      ),
    ];
  return [
    "Changes together (git history):",
    ...result.partners.map(
      (p) =>
        `  ${p.path}${p.name ? `:${p.name}` : ""} — support ${p.support}, confidence ${p.confidence.toFixed(2)}, last ${p.lastCoChange}`,
    ),
    ...result.recentFixes.map((c) => `  Recent fix: ${c.sha} ${c.date} ${c.subject}`),
  ];
}
