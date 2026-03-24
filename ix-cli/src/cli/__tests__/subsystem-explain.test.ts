import { describe, expect, it } from "vitest";
import {
  renderSubsystemExplanationJson,
  renderSubsystemExplanationText,
  type ScopedSubsystemResult,
  type ScopedSubsystemRegion,
  type SubsystemScore,
} from "../explain/subsystem.js";

function region(overrides: Partial<ScopedSubsystemRegion> = {}): ScopedSubsystemRegion {
  return {
    id: overrides.id ?? "region-1",
    label: overrides.label ?? "Ingestion Layer",
    level: overrides.level ?? 2,
    label_kind: overrides.label_kind ?? "subsystem",
    parent_id: overrides.parent_id ?? "parent-1",
    file_count: overrides.file_count ?? 34,
    confidence: overrides.confidence ?? 0.88,
    is_cross_cutting: overrides.is_cross_cutting ?? false,
    dominant_signals: overrides.dominant_signals ?? ["import coupling", "path proximity"],
    children: overrides.children,
  };
}

function scopedResult(overrides: Partial<ScopedSubsystemResult> = {}): ScopedSubsystemResult {
  return {
    target: overrides.target ?? region(),
    parent: overrides.parent ?? {
      id: "parent-1",
      label: "Core System",
      level: 3,
      label_kind: "system",
    },
    summary: overrides.summary ?? {
      well_defined: 3,
      moderate: 1,
      fuzzy: 0,
      cross_cutting: 0,
    },
    children: overrides.children ?? [
      region({ id: "child-1", label: "File Parser", level: 1, label_kind: "module", file_count: 12, confidence: 0.91 }),
      region({ id: "child-2", label: "Patch Builder", level: 1, label_kind: "module", file_count: 9, confidence: 0.84 }),
      region({ id: "child-3", label: "Bulk Writer", level: 1, label_kind: "module", file_count: 8, confidence: 0.66 }),
      region({ id: "child-4", label: "Loader", level: 1, label_kind: "module", file_count: 5, confidence: 0.44 }),
    ],
    hierarchy: overrides.hierarchy ?? region({
      children: overrides.children ?? [
        region({ id: "child-1", label: "File Parser", level: 1, label_kind: "module", file_count: 12, confidence: 0.91 }),
      ],
    }),
  };
}

function score(overrides: Partial<SubsystemScore> = {}): SubsystemScore {
  return {
    region_id: overrides.region_id ?? "region-1",
    name: overrides.name ?? "Ingestion Layer",
    level: overrides.level ?? 2,
    label_kind: overrides.label_kind ?? "subsystem",
    file_count: overrides.file_count ?? 34,
    health_score: overrides.health_score ?? 0.74,
    chunk_density: overrides.chunk_density ?? 5.1,
    smell_rate: overrides.smell_rate ?? 0.06,
    smell_files: overrides.smell_files ?? 2,
    total_chunks: overrides.total_chunks ?? 173,
    confidence: overrides.confidence ?? 0.88,
    inference_version: overrides.inference_version ?? "subsystem_v1",
  };
}

describe("subsystem explanation rendering", () => {
  it("renders structured json with composition and health", () => {
    const rendered = renderSubsystemExplanationJson(scopedResult(), score());

    expect(rendered.resolvedTarget.label).toBe("Ingestion Layer");
    expect(rendered.context.parent?.label).toBe("Core System");
    expect(rendered.composition?.children).toHaveLength(4);
    expect(rendered.health?.status).toBe("good");
    expect(rendered.notes).toEqual([]);
    expect(rendered.whyItMatters).toContain("ix impact");
  });

  it("omits health and adds a note when scores are missing", () => {
    const rendered = renderSubsystemExplanationJson(scopedResult(), null);

    expect(rendered.health).toBeNull();
    expect(rendered.notes).toEqual(["Run 'ix subsystems' to compute health scores for this region."]);
  });

  it("flags cross-cutting fuzzy subsystems as drift risk", () => {
    const rendered = renderSubsystemExplanationJson(
      scopedResult({
        target: region({
          label: "Shared Auth",
          confidence: 0.41,
          is_cross_cutting: true,
        }),
      }),
      score({ health_score: 0.39, smell_files: 3 }),
    );

    expect(rendered.whyItMatters).toContain("architectural drift");
  });

  it("renders text sections for a healthy subsystem explanation", () => {
    const rendered = renderSubsystemExplanationText(scopedResult(), score());

    expect(rendered).toContain("Explanation");
    expect(rendered).toContain("Context");
    expect(rendered).toContain("Composition");
    expect(rendered).toContain("Health");
    expect(rendered).toContain("Why it matters");
    expect(rendered).toContain("Ingestion Layer");
  });
});
