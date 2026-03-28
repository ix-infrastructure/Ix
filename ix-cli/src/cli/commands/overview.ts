import * as nodePath from "node:path";
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity, printResolved } from "../resolve.js";
import { getSystemPath, hasMapData } from "../hierarchy.js";
import { humanizeLabel } from "../impact/risk-semantics.js";
import { relativePath } from "../format.js";
import { renderSection, renderKeyValue, renderNote, renderBreadcrumb } from "../ui.js";

const CONTAINER_KINDS = new Set(["class", "module", "file", "trait", "object", "interface"]);
const STRUCTURAL_CONTAINER_KINDS = new Set(["class", "object", "trait", "interface"]);
const REGION_KINDS = new Set(["system", "subsystem", "module", "region"]);
const FILE_KINDS = new Set(["file"]);

const KEY_ITEMS_LIMIT = 5;

interface OverviewResult {
  resolvedTarget: { id: string; kind: string; name: string };
  resolutionMode: string;
  path: string | null;
  systemPath: Array<{ name: string; kind: string }> | null;
  hasMapData: boolean;
  // Container targets
  childrenByKind: Record<string, number> | null;
  keyItems: Array<{ name: string; kind: string }> | null;
  // Leaf targets
  containedIn: { kind: string; name: string } | null;
  siblingsByKind: Record<string, number> | null;
  keySiblings: Array<{ name: string; kind: string }> | null;
  diagnostics: string[];
}

export function registerOverviewCommand(program: Command): void {
  program
    .command("overview <target>")
    .description("Structural summary — what a target contains or what surrounds it")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Prefer symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText(
      "after",
      `\nUse overview for structural summaries. Use 'ix locate' for position.
Use 'ix explain' for role. Use 'ix impact' for risk.

Examples:
  ix overview IngestionService
  ix overview IngestionService --kind class
  ix overview verify_token --kind function --format json
  ix overview src/cli/commands/overview.ts
  ix overview overview.ts
  ix overview scoreCandidate --pick 2`
    )
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };
      const target = await resolveFileOrEntity(client, symbol, resolveOpts);
      if (!target) return;

      if (opts.format !== "json") printResolved(target);

      const isContainer = CONTAINER_KINDS.has(target.kind);
      const isRegion = REGION_KINDS.has(target.kind);

      if (isContainer || isRegion) {
        await overviewContainer(client, target, opts.format);
      } else {
        await overviewLeaf(client, target, opts.format);
      }
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toRepoRelative(filePath: string): string {
  return relativePath(filePath) ?? filePath;
}

function humanizeBreadcrumb(nodes: Array<{ name: string; kind: string }>): string {
  const humanized = nodes.map((n) => {
    if (REGION_KINDS.has(n.kind)) return humanizeLabel(n.name).replace(/ layer$/, "");
    return n.name;
  });
  return renderBreadcrumb(humanized.map((name) => ({ name })));
}

/** Label for the "Key ..." section based on target kind. */
function keyItemsLabel(kind: string): string {
  if (FILE_KINDS.has(kind)) return "Key definitions";
  if (REGION_KINDS.has(kind)) return "Key files";
  return "Key members";
}

/** Humanize a kind for the Contains/Nearby section (e.g. "method" → "Methods"). */
function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    method: "Methods",
    function: "Functions",
    field: "Fields",
    class: "Classes",
    interface: "Interfaces",
    trait: "Traits",
    object: "Objects",
    file: "Files",
    enum: "Enums",
    type: "Types",
    type_alias: "Type aliases",
    module: "Modules",
    region: "Regions",
    subsystem: "Subsystems",
    constructor: "Constructors",
    def: "Methods",
    fun: "Functions",
    val: "Fields",
    var: "Fields",
  };
  const label = labels[kind.toLowerCase()];
  if (label) return label;
  return kind.charAt(0).toUpperCase() + kind.slice(1) + "s";
}

/** Sibling label: "Sibling methods", "Sibling functions", etc. */
function siblingKindLabel(kind: string): string {
  return `Sibling ${kindLabel(kind).toLowerCase()}`;
}

// ── Container / Region overview ─────────────────────────────────────────────

async function overviewContainer(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  format: string
): Promise<void> {
  const diagnostics: string[] = [];
  const isRegion = REGION_KINDS.has(target.kind);

  const childPredicate = isRegion ? "IN_REGION" : "CONTAINS";

  const [details, childrenResult, systemPath] = await Promise.all([
    client.entity(target.id),
    client.expand(target.id, { direction: "out", predicates: [childPredicate] }),
    getSystemPath(client, target.id),
  ]);

  const node = details.node as any;
  const rawPath = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? null;
  const displayPath = rawPath ? toRepoRelative(rawPath) : null;

  const children = childrenResult.nodes;

  const childrenByKind: Record<string, number> = {};
  const childList: Array<{ name: string; kind: string }> = [];
  for (const m of children) {
    const member = m as any;
    const kind = member.kind || "unknown";
    const name = member.name || member.attrs?.name || "(unnamed)";
    childrenByKind[kind] = (childrenByKind[kind] || 0) + 1;
    childList.push({ name, kind });
  }

  const keyItems = childList.slice(0, KEY_ITEMS_LIMIT);

  const hasMap = hasMapData(systemPath);
  if (!hasMap) {
    diagnostics.push("No system map. Run `ix map` to see hierarchy.");
  }

  // Append container symbol to system path for non-file, non-region containers
  let systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));
  if (!FILE_KINDS.has(target.kind) && !isRegion) {
    const lastInPath = systemPathMapped[systemPathMapped.length - 1];
    if (!lastInPath || lastInPath.name !== target.name) {
      systemPathMapped = [...systemPathMapped, { name: target.name, kind: target.kind }];
    }
  }

  const result: OverviewResult = {
    resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
    resolutionMode: target.resolutionMode,
    path: displayPath,
    systemPath: systemPathMapped,
    hasMapData: hasMap,
    childrenByKind: Object.keys(childrenByKind).length > 0 ? childrenByKind : null,
    keyItems: keyItems.length > 0 ? keyItems : null,
    containedIn: null,
    siblingsByKind: null,
    keySiblings: null,
    diagnostics,
  };

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  renderOverviewHeader(target, displayPath, null, systemPathMapped, hasMap);

  if (Object.keys(childrenByKind).length > 0) {
    renderSection("Contains");
    const sorted = Object.entries(childrenByKind).sort((a, b) => b[1] - a[1]);
    for (const [kind, count] of sorted) {
      renderKeyValue(kindLabel(kind), String(count));
    }
  }

  if (keyItems.length > 0) {
    renderSection(keyItemsLabel(target.kind));
    for (const item of keyItems) {
      console.log(`  ${item.name}`);
    }
  }

  renderDiagnostics(diagnostics);
}

// ── Leaf (function/method/field) overview ────────────────────────────────────

async function overviewLeaf(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  format: string
): Promise<void> {
  const diagnostics: string[] = [];

  // Fetch entity details, system path, and parent container in parallel
  const [details, systemPath, parentResult] = await Promise.all([
    client.entity(target.id),
    getSystemPath(client, target.id),
    client.expand(target.id, { direction: "in", predicates: ["CONTAINS"] }),
  ]);

  const node = details.node as any;
  const rawPath = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? null;
  const displayPath = rawPath ? toRepoRelative(rawPath) : null;

  const hasMap = hasMapData(systemPath);
  if (!hasMap) {
    diagnostics.push("No system map. Run `ix map` to see hierarchy.");
  }

  // Append target to system path if not already there
  let systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));
  const lastInPath = systemPathMapped[systemPathMapped.length - 1];
  if (!lastInPath || lastInPath.name !== target.name) {
    systemPathMapped = [...systemPathMapped, { name: target.name, kind: target.kind }];
  }

  // Find nearest meaningful container
  // Prefer class/object/trait/interface, fall back to file
  let containedIn: { kind: string; name: string } | null = null;
  let containerId: string | null = null;

  const parents = parentResult.nodes as any[];
  const structuralParent = parents.find((p) => STRUCTURAL_CONTAINER_KINDS.has(p.kind));
  const fileParent = parents.find((p) => FILE_KINDS.has(p.kind));
  const bestParent = structuralParent ?? fileParent ?? parents[0];

  if (bestParent) {
    containedIn = {
      kind: bestParent.kind || "unknown",
      name: bestParent.name || bestParent.attrs?.name || "(unknown)",
    };
    containerId = bestParent.id;
  }

  // Fetch siblings from the container
  let siblingsByKind: Record<string, number> | null = null;
  let keySiblings: Array<{ name: string; kind: string }> | null = null;

  if (containerId) {
    try {
      const siblingsResult = await client.expand(containerId, {
        direction: "out",
        predicates: ["CONTAINS"],
      });

      const siblings = (siblingsResult.nodes as any[]).filter(
        (n) => n.id !== target.id
      );

      if (siblings.length > 0) {
        // Group siblings by kind
        const byKind: Record<string, number> = {};
        const siblingList: Array<{ name: string; kind: string }> = [];
        for (const s of siblings) {
          const kind = s.kind || "unknown";
          const name = s.name || s.attrs?.name || "(unnamed)";
          byKind[kind] = (byKind[kind] || 0) + 1;
          siblingList.push({ name, kind });
        }
        siblingsByKind = byKind;

        // Key siblings: prefer same kind, then others, exclude target
        const sameKind = siblingList.filter((s) => s.kind === target.kind);
        const otherKind = siblingList.filter((s) => s.kind !== target.kind);
        const ordered = [...sameKind, ...otherKind];
        if (ordered.length > 0) {
          keySiblings = ordered.slice(0, KEY_ITEMS_LIMIT);
        }
      }
    } catch {
      diagnostics.push("Could not fetch sibling structure.");
    }
  }

  const result: OverviewResult = {
    resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
    resolutionMode: target.resolutionMode,
    path: displayPath,
    systemPath: systemPathMapped,
    hasMapData: hasMap,
    childrenByKind: null,
    keyItems: null,
    containedIn,
    siblingsByKind,
    keySiblings,
    diagnostics,
  };

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  renderOverviewHeader(target, displayPath, containedIn, systemPathMapped, hasMap);

  // Nearby structure
  if (siblingsByKind && Object.keys(siblingsByKind).length > 0) {
    renderSection("Nearby structure");
    const sorted = Object.entries(siblingsByKind).sort((a, b) => b[1] - a[1]);
    for (const [kind, count] of sorted) {
      renderKeyValue(siblingKindLabel(kind), String(count));
    }
  }

  // Key siblings
  if (keySiblings && keySiblings.length > 0) {
    renderSection("Key siblings");
    for (const s of keySiblings) {
      console.log(`  ${s.name}`);
    }
  }

  renderDiagnostics(diagnostics);
}

// ── Shared rendering ────────────────────────────────────────────────────────

function renderOverviewHeader(
  target: { kind: string; name: string },
  displayPath: string | null,
  containedIn: { kind: string; name: string } | null,
  systemPath: Array<{ name: string; kind: string }>,
  hasMap: boolean,
): void {
  renderSection("Overview");
  renderKeyValue("Kind", target.kind);
  if (displayPath) {
    renderKeyValue("File", displayPath);
  }
  if (containedIn) {
    const containerLabel = STRUCTURAL_CONTAINER_KINDS.has(containedIn.kind)
      ? `${containedIn.kind} ${containedIn.name}`
      : containedIn.name;
    renderKeyValue("Contained in", containerLabel);
  }
  if (systemPath.length > 1 && hasMap) {
    renderKeyValue("System path", humanizeBreadcrumb(systemPath));
  }
}

function renderDiagnostics(diagnostics: string[]): void {
  for (const d of diagnostics) {
    renderNote(d);
  }
}
