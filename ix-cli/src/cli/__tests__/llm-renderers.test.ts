import { describe, it, expect } from "vitest";
import { renderMapLlm, type MapRegion, type MapResult } from "../commands/map.js";
import { renderSubsystemScoreLlm } from "../commands/subsystems.js";
import type { SubsystemScore } from "../explain/subsystem.js";

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

function region(over: Partial<MapRegion>): MapRegion {
  return {
    id: "r", label: "R", label_kind: "module", level: 1, file_count: 1,
    child_region_count: 0, parent_id: null, cohesion: 0, external_coupling: 0,
    boundary_ratio: 0, confidence: 0, crosscut_score: 0, dominant_signals: [],
    interface_node_count: 0, ...over,
  };
}

describe("renderMapLlm", () => {
  it("emits a summary line then flat region records with parent=", () => {
    const result: MapResult = {
      file_count: 100, region_count: 2, levels: 2, map_rev: 7,
      outcome: "ok", regions: [], hierarchy: [],
    };
    const regions = [
      region({ id: "root", label: "Cli", label_kind: "system", level: 2, file_count: 100, child_region_count: 2, confidence: 0.9 }),
      region({ id: "cli", label: "Cli / Client", label_kind: "subsystem", level: 1, file_count: 87, parent_id: "root", confidence: 0.62, dominant_signals: ["naming", "imports"] }),
    ];
    const lines = captureLog(() => renderMapLlm(result, regions));

    expect(lines[0]).toBe("map files=100 regions=2 levels=2 rev=7 outcome=ok");
    // root: parent_id null is dropped; child_region_count surfaces as children;
    // float metrics (cohesion/coupling) are emitted even at 0 since the value carries signal
    expect(lines[1]).toBe("region id=root kind=system label=Cli level=2 files=100 children=2 cohesion=0 coupling=0 confidence=0.9");
    // child: parent= present, label with spaces is quoted, signals joined by comma
    expect(lines[2]).toBe('region id=cli kind=subsystem label="Cli / Client" level=1 files=87 parent=root cohesion=0 coupling=0 confidence=0.62 signals=naming,imports');
  });

  it("drops zero children and empty signals", () => {
    const result: MapResult = {
      file_count: 1, region_count: 1, levels: 1, map_rev: 1,
      regions: [], hierarchy: [],
    };
    const lines = captureLog(() => renderMapLlm(result, [region({ id: "x", label: "X" })]));
    expect(lines[1]).toBe("region id=x kind=module label=X level=1 files=1 cohesion=0 coupling=0 confidence=0");
    expect(lines[1]).not.toContain("children=");
    expect(lines[1]).not.toContain("signals=");
    expect(lines[1]).not.toContain("parent=");
  });
});

describe("renderSubsystemScoreLlm", () => {
  const base: SubsystemScore = {
    region_id: "cli-client", name: "Cli / Client", level: 2, label_kind: "subsystem",
    file_count: 87, health_score: 0.623, chunk_density: 4.07, smell_rate: 0.1,
    smell_files: 3, total_chunks: 354, confidence: 0.88, inference_version: "v1",
  };

  it("renders a region record with rounded floats and quoted label", () => {
    expect(renderSubsystemScoreLlm(base)).toBe(
      'region id=cli-client label="Cli / Client" kind=subsystem level=2 files=87 health=0.62 chunks_per_file=4.07 smells=3 confidence=0.88'
    );
  });

  it("drops smells when zero", () => {
    expect(renderSubsystemScoreLlm({ ...base, smell_files: 0 })).not.toContain("smells=");
  });
});
