export interface SubsystemScore {
  region_id: string;
  name: string;
  level: number;
  label_kind: string;
  file_count: number;
  health_score: number;
  chunk_density: number;
  smell_rate: number;
  smell_files: number;
  total_chunks: number;
  confidence: number;
  inference_version: string;
}

export interface ScopedSubsystemRegion {
  id: string;
  label: string;
  level: number;
  label_kind: string;
  parent_id: string | null;
  file_count: number;
  confidence: number;
  is_cross_cutting: boolean;
  dominant_signals: string[];
  children?: ScopedSubsystemRegion[];
}

export interface ScopedSubsystemResult {
  target: ScopedSubsystemRegion;
  parent?: {
    id: string;
    label: string;
    level: number;
    label_kind: string;
  } | null;
  summary: {
    well_defined: number;
    moderate: number;
    fuzzy: number;
    cross_cutting: number;
  };
  children: ScopedSubsystemRegion[];
  hierarchy: ScopedSubsystemRegion;
}

export interface SubsystemExplanationJson {
  resolvedTarget: {
    id: string;
    label: string;
    level: number;
    label_kind: string;
  };
  explanation: string;
  context: {
    level: number;
    label_kind: string;
    parent: {
      id: string;
      label: string;
      label_kind: string;
    } | null;
    file_count: number;
    child_count: number;
    confidence: number;
    dominant_signals: string[];
    is_cross_cutting: boolean;
  };
  composition: {
    children: Array<{
      label: string;
      level: number;
      label_kind: string;
      file_count: number;
      confidence: number;
      is_cross_cutting: boolean;
    }>;
    summary: {
      well_defined: number;
      moderate: number;
      fuzzy: number;
      cross_cutting: number;
    };
    omitted_child_count: number;
  } | null;
  health: {
    score: number;
    chunk_density: number;
    smell_rate: number;
    smell_files: number;
    total_chunks: number;
    status: "healthy" | "good" | "moderate" | "needs_attention";
  } | null;
  whyItMatters: string;
  notes: string[];
}

const MAX_COMPOSITION_CHILDREN = 10;

export function renderSubsystemExplanationJson(
  scoped: ScopedSubsystemResult,
  score: SubsystemScore | null,
): SubsystemExplanationJson {
  const target = scoped.target;
  const children = sortRegions(scoped.children);
  const visibleChildren = children.slice(0, MAX_COMPOSITION_CHILDREN);
  const notes = score ? [] : ["Run 'ix subsystems' to compute health scores for this region."];
  const health = score ? renderHealthJson(score) : null;

  return {
    resolvedTarget: {
      id: target.id,
      label: target.label,
      level: target.level,
      label_kind: target.label_kind,
    },
    explanation: synthesizeSubsystemExplanation(target, scoped.parent ?? null),
    context: {
      level: target.level,
      label_kind: target.label_kind,
      parent: scoped.parent
        ? {
            id: scoped.parent.id,
            label: scoped.parent.label,
            label_kind: scoped.parent.label_kind,
          }
        : null,
      file_count: target.file_count,
      child_count: scoped.children.length,
      confidence: target.confidence,
      dominant_signals: target.dominant_signals,
      is_cross_cutting: target.is_cross_cutting,
    },
    composition: scoped.children.length > 0
      ? {
          children: visibleChildren.map((child) => ({
            label: child.label,
            level: child.level,
            label_kind: child.label_kind,
            file_count: child.file_count,
            confidence: child.confidence,
            is_cross_cutting: child.is_cross_cutting,
          })),
          summary: { ...scoped.summary },
          omitted_child_count: Math.max(children.length - visibleChildren.length, 0),
        }
      : null,
    health,
    whyItMatters: renderWhyItMatters(target, scoped.parent ?? null, score),
    notes,
  };
}

export function renderSubsystemExplanationText(
  scoped: ScopedSubsystemResult,
  score: SubsystemScore | null,
): string {
  const rendered = renderSubsystemExplanationJson(scoped, score);
  const lines: string[] = [];

  lines.push("Explanation");
  lines.push(`  ${rendered.explanation}`);
  lines.push("");
  lines.push("Context");
  lines.push(`  Level:       ${rendered.context.label_kind} (level ${rendered.context.level})`);
  if (rendered.context.parent) {
    lines.push(`  Parent:      ${rendered.context.parent.label} (${rendered.context.parent.label_kind})`);
  }
  lines.push(`  Files:       ${rendered.context.file_count}`);
  if (rendered.context.child_count > 0) {
    lines.push(`  Children:    ${rendered.context.child_count} ${pluralize(rendered.context.child_count, childKindLabel(scoped.children))}`);
  }
  lines.push(`  Confidence:  ${confidenceLabel(rendered.context.confidence)} (${Math.round(rendered.context.confidence * 100)}%)`);
  if (rendered.context.dominant_signals.length > 0) {
    lines.push(`  Signals:     ${rendered.context.dominant_signals.join(" · ")}`);
  }
  if (rendered.context.is_cross_cutting) {
    lines.push("  Scope:       Cross-cutting");
  }

  if (rendered.composition) {
    lines.push("");
    lines.push("Composition");
    for (const child of rendered.composition.children) {
      lines.push(`  ${formatCompositionLine(child)}`);
    }
    if (rendered.composition.omitted_child_count > 0) {
      lines.push(`  ... ${rendered.composition.omitted_child_count} more. Use 'ix subsystems ${JSON.stringify(scoped.target.label)}' for the full tree.`);
    }
    lines.push(
      `  ${rendered.composition.summary.well_defined} well-defined · ` +
      `${rendered.composition.summary.moderate} moderate · ` +
      `${rendered.composition.summary.fuzzy} fuzzy · ` +
      `${rendered.composition.summary.cross_cutting} cross-cutting`
    );
  }

  if (rendered.health) {
    lines.push("");
    lines.push("Health");
    lines.push(`  Score:          ${plainHealthBar(rendered.health.score)}  ${rendered.health.score.toFixed(2)}`);
    lines.push(`  Chunk density:  ${rendered.health.chunk_density.toFixed(1)} chunks/file`);
    lines.push(`  Smell rate:     ${Math.round(rendered.health.smell_rate * 100)}%  (${rendered.health.smell_files} files flagged)`);
    lines.push(`  Status:         ${healthStatusPhrase(rendered.health.score)}${densityNote(rendered.health.chunk_density)}`);
  }

  lines.push("");
  lines.push("Why it matters");
  lines.push(`  ${rendered.whyItMatters}`);

  if (rendered.notes.length > 0) {
    lines.push("");
    lines.push(rendered.notes.length === 1 ? "Note" : "Notes");
    for (const note of rendered.notes) {
      lines.push(`  ${note}`);
    }
  }

  return lines.join("\n");
}

export function synthesizeSubsystemExplanation(
  region: ScopedSubsystemRegion,
  parent: ScopedSubsystemResult["parent"] | null,
): string {
  const regionNoun = articleFor(region.label_kind) + region.label_kind;
  const parentPhrase = parent ? ` inside ${parent.label}` : "";
  const confidencePhrase = confidenceSentence(region.confidence);
  const crossCuttingPhrase = region.is_cross_cutting
    ? " It is cross-cutting and spans multiple neighboring regions."
    : "";
  const signalPhrase = primarySignalSentence(region.dominant_signals);

  return (
    `\`${region.label}\` serves as ${regionNoun} spanning ${region.file_count} ` +
    `${pluralize(region.file_count, "file")}${parentPhrase}. ` +
    `It is ${confidencePhrase}.${signalPhrase}${crossCuttingPhrase}`
  ).replace(/\s+/g, " ").trim();
}

function renderWhyItMatters(
  region: ScopedSubsystemRegion,
  parent: ScopedSubsystemResult["parent"] | null,
  score: SubsystemScore | null,
): string {
  if (region.is_cross_cutting && region.confidence < 0.5) {
    return (
      `${region.label} spans multiple subsystems and has low clustering confidence, ` +
      "which suggests architectural drift. Consider clarifying or decomposing its boundaries."
    );
  }

  if (score && score.health_score >= 0.8 && region.level === 3) {
    return (
      `${region.label} is a stable, well-defined system boundary. Changes within it are usually ` +
      `well-contained. Run \`ix impact ${JSON.stringify(region.label)}\` to review cross-system dependencies.`
    );
  }

  if (score && score.health_score < 0.45 && score.smell_files > 0) {
    return (
      `${region.label} has ${score.smell_files} ${pluralize(score.smell_files, "file")} with active smell claims ` +
      `and a health score of ${score.health_score.toFixed(2)}. Prioritize refactoring here before expanding the subsystem. ` +
      "Run `ix smells` to review."
    );
  }

  const parentPhrase = parent ? ` inside ${parent.label}` : "";
  const densityPhrase = score
    ? densityNote(score.chunk_density).trimStart()
    : "";
  return (
    `${region.label} is a ${confidenceLabel(region.confidence).toLowerCase()} ${region.label_kind}${parentPhrase}. ` +
    `Run \`ix impact ${JSON.stringify(region.label)}\` to understand its downstream blast radius.${densityPhrase}`
  ).trim();
}

function renderHealthJson(score: SubsystemScore): NonNullable<SubsystemExplanationJson["health"]> {
  return {
    score: score.health_score,
    chunk_density: score.chunk_density,
    smell_rate: score.smell_rate,
    smell_files: score.smell_files,
    total_chunks: score.total_chunks,
    status: healthStatus(score.health_score),
  };
}

function healthStatus(score: number): "healthy" | "good" | "moderate" | "needs_attention" {
  if (score >= 0.8) return "healthy";
  if (score >= 0.65) return "good";
  if (score >= 0.45) return "moderate";
  return "needs_attention";
}

function healthStatusPhrase(score: number): string {
  switch (healthStatus(score)) {
    case "healthy":
      return "Healthy - rich structure, minimal technical debt";
    case "good":
      return "Good - rich structure, low smell coverage";
    case "moderate":
      return "Moderate - structure is present, smell coverage is elevated";
    case "needs_attention":
      return "Needs attention - sparse structure or significant smell coverage";
  }
}

function densityNote(chunkDensity: number): string {
  if (chunkDensity >= 5.0) {
    return " High chunk density indicates thorough code coverage in the knowledge graph.";
  }
  if (chunkDensity < 2.0) {
    return " Low chunk density - run 'ix ingest' to improve coverage.";
  }
  return "";
}

function primarySignalSentence(signals: string[]): string {
  if (signals.length === 0) return "";
  if (signals.length === 1) {
    return ` Its primary structural signal is ${signals[0]}.`;
  }
  return ` Its primary structural signals are ${signals.slice(0, 2).join(" and ")}.`;
}

function confidenceSentence(confidence: number): string {
  if (confidence >= 0.75) return "well-defined";
  if (confidence >= 0.5) return "moderately defined";
  return "loosely defined";
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.75) return "Well-defined";
  if (confidence >= 0.5) return "Moderate";
  return "Fuzzy";
}

function plainHealthBar(score: number): string {
  const filled = Math.round(score * 5);
  return "█".repeat(filled) + "░".repeat(5 - filled);
}

function formatCompositionLine(region: {
  label: string;
  label_kind: string;
  file_count: number;
  confidence: number;
  is_cross_cutting: boolean;
}): string {
  const kind = region.label_kind.toUpperCase().padEnd(9);
  const label = region.label.padEnd(24);
  const confidence = `${confidenceLabel(region.confidence)} ${Math.round(region.confidence * 100)}%`.padEnd(17);
  const scope = region.is_cross_cutting ? "  shared" : "";
  return `● ${kind}${label}${confidence}${String(region.file_count).padStart(4)} ${pluralize(region.file_count, "file")}${scope}`;
}

function childKindLabel(children: ScopedSubsystemRegion[]): string {
  const first = children[0]?.label_kind;
  if (!first || !children.every((child) => child.label_kind === first)) {
    return "child";
  }
  return first;
}

function sortRegions(children: ScopedSubsystemRegion[]): ScopedSubsystemRegion[] {
  return [...children].sort((a, b) => b.file_count - a.file_count || b.confidence - a.confidence || a.label.localeCompare(b.label));
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function articleFor(noun: string): string {
  return /^[aeiou]/i.test(noun) ? "an " : "a ";
}
