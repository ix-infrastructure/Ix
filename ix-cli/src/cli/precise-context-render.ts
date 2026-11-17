// Copyright 2026 Ix Infrastructure Inc.

// Compact context pages; the legacy renderer remains in context/render.ts.
import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { resolveWorkspaceRoot } from "./config.js";
import { gitRepoAccess, type RepoAccess } from "./explain/text-references.js";
import { llmLine, printLlmLines } from "./llm.js";
import { printJson } from "./format.js";
import { reportFailure } from "./ui.js";
import { renderBundle as renderFullBundle } from "./context/render.js";
import type { ContextBundle } from "./context/types.js";
import { asString } from "./context/util.js";
import {
  bundleContextCandidates, preciseContextLlmLines, selectContextItems,
  type ContextSelectionOptions,
} from "./precise-context.js";

/** A lazy, tracked-source reader; never follow a graph path outside the workspace. */
export function contextSourceReader(): (path: string) => string | undefined {
  let access: RepoAccess | undefined;
  let tracked: Set<string> | undefined;
  let root: string;
  const cache = new Map<string, string | undefined>();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    try {
      root ??= realpathSync(resolveWorkspaceRoot());
      if (!tracked) {
        access = gitRepoAccess(root);
        tracked = new Set(access?.files());
      }
      if (!tracked.has(path)) return undefined;
      const rel = relative(root, realpathSync(resolve(root, path)));
      if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) return undefined;
      const text = access?.read(path);
      cache.set(path, text);
      return text;
    } catch { return undefined; }
  };
}

/** Compact tool contract. The original bundle/row contract is explicit --full. */
export function renderBundle(bundle: ContextBundle, format: string, options: ContextSelectionOptions & { full?: boolean } = {}): void {
  if (options.full || (format !== "json" && format !== "llm")) {
    renderFullBundle(bundle, format);
    return;
  }
  try {
    const metadata = { target: bundle.target, freshness: bundle.freshness,
      ...(bundle.graph ? { graph: bundle.graph } : {}),
      sourceTruncation: bundle.truncation,
    };
    const selectionOptions = { ...options,
      maxChars: (options.maxChars ?? bundle.budgets.maxChars) - JSON.stringify(metadata, null, 2).length - 100,
    };
    const page = selectContextItems(bundleContextCandidates(bundle, options), selectionOptions);
    if (format === "json") printJson({ ...page, ...metadata });
    else printLlmLines([
      llmLine("target", { name: bundle.target.name, classification: bundle.freshness.classification }),
      ...(bundle.graph ? [llmLine("graph", { status: asString(bundle.graph.status), message: asString(bundle.graph.message), fix: asString(bundle.graph.fix) })] : []),
      ...preciseContextLlmLines(page),
      ...(bundle.truncation.entitiesTruncated || bundle.truncation.evidenceTruncated ? [llmLine("diagnostic", {
        code: "source_truncated", entities: bundle.truncation.entitiesTruncated, evidence: bundle.truncation.evidenceTruncated,
        message: "Increase --max-entities/--max-evidence for a larger candidate pool; --full returns the legacy bundle",
      })] : []),
    ]);
  } catch (error) {
    reportFailure("context_selection", (error as Error).message, format);
  }
}
