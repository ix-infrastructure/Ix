// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { llmLine } from "../llm.js";
import { emit, type Renderer } from "../output/emit.js";
import { relativePath } from "../output/rows.js";

/** Render patch records as llm `patch` lines. */
export function renderPatchesLlm(patches: any[]): string[] {
  return patches.map((p) => llmLine("patch", [
    ["rev", p.rev],
    ["id", p.patch_id?.slice(0, 12)],
    ["intent", p.intent || undefined],
    ["ts", p.timestamp],
    ["source", relativePath(p.source?.uri) || undefined],
  ]));
}

/** Patch history (`ix patches`): compact records as json, `patch` lines as llm. */
export const patchesRenderer: Renderer<any[]> = {
  json: (patches) => patches.map(p => ({
    rev: p.rev,
    patch_id: p.patch_id?.slice(0, 12),
    intent: p.intent || undefined,
    timestamp: p.timestamp,
    source: relativePath(p.source?.uri) || undefined,
  })),
  llm: renderPatchesLlm,
  text: printPatchesText,
};

export function formatPatches(patches: any[], format: string): void {
  emit(patchesRenderer, patches, format);
}

function printPatchesText(patches: any[]): void {
  if (patches.length === 0) {
    console.log("No patches found.");
    return;
  }
  for (const p of patches) {
    const shortPatchId =
      p.patch_id.length > 8 ? p.patch_id.slice(0, 8) : p.patch_id;
    const intentPart = p.intent
      ? chalk.white(p.intent)
      : chalk.dim("(no intent)");
    console.log(
      `  rev ${chalk.cyan.bold(String(p.rev))}  ${chalk.dim(shortPatchId)}  ${intentPart}`
    );
  }
}
