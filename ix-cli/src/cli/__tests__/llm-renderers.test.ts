import { describe, it, expect } from "vitest";
import { renderMapLlm, type MapRegion, type MapResult } from "../commands/map.js";
import { renderSubsystemScoreLlm, renderScopedSubsystemLlm, renderSubsystemErrorLlm } from "../commands/subsystems.js";
import type { SubsystemScore, ScopedSubsystemRegion, ScopedSubsystemResult } from "../explain/subsystem.js";
import { renderStatsLlm } from "../commands/stats.js";
import { renderSmellsRunLlm, renderSmellsListLlm } from "../commands/smells.js";
import { impactHeaderLlm, impactPropagationLlm, impactTailLlm } from "../commands/impact.js";
import { overviewContainerLlm, overviewLeafLlm } from "../commands/overview.js";

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

  it("drops smells and chunks_per_file when zero (no-signal noise)", () => {
    const line = renderSubsystemScoreLlm({ ...base, smell_files: 0, chunk_density: 0 });
    expect(line).not.toContain("smells=");
    expect(line).not.toContain("chunks_per_file=");
    expect(line).toContain("health=0.62");
  });
});

describe("renderScopedSubsystemLlm", () => {
  function scopedRegion(over: Partial<ScopedSubsystemRegion>): ScopedSubsystemRegion {
    return {
      id: "x", label: "X", level: 1, label_kind: "module", parent_id: null,
      file_count: 1, confidence: 0, is_cross_cutting: false, dominant_signals: [], ...over,
    };
  }
  it("emits target, health, then flat region records with parent=", () => {
    const result: ScopedSubsystemResult = {
      target: scopedRegion({ id: "auth", label: "Auth", label_kind: "subsystem", level: 2, file_count: 42, confidence: 0.8, dominant_signals: ["imports"] }),
      parent: { id: "root", label: "Sys", level: 3, label_kind: "system" },
      summary: { well_defined: 1, moderate: 2, fuzzy: 0, cross_cutting: 1 },
      children: [scopedRegion({ id: "c1", label: "Login", parent_id: "auth", confidence: 0.5, is_cross_cutting: true })],
      hierarchy: scopedRegion({ id: "auth" }),
    };
    const lines = renderScopedSubsystemLlm(result);
    expect(lines[0]).toBe('target id=auth label=Auth kind=subsystem level=2 files=42 confidence=0.8 parent=root signals=imports');
    expect(lines[1]).toBe("health well_defined=1 moderate=2 fuzzy=0 cross_cutting=1");
    expect(lines[2]).toBe("region id=c1 label=Login kind=module level=1 files=1 parent=auth confidence=0.5 cross_cutting=true");
  });
});

describe("renderSubsystemErrorLlm", () => {
  it("renders ambiguous_target with candidate list", () => {
    const line = renderSubsystemErrorLlm({ error: "ambiguous_target", target_query: "Auth", candidates: [{ pick: 1, label: "Auth", level: 2, label_kind: "subsystem", file_count: 4 }, { pick: 2, label: "AuthZ", level: 2, label_kind: "subsystem", file_count: 2 }] });
    expect(line).toBe('error code=ambiguous_target message="Multiple regions matched \\"Auth\\"." candidates=1:Auth,2:AuthZ');
  });
  it("renders unknown_target with suggestions", () => {
    const line = renderSubsystemErrorLlm({ error: "unknown_target", target_query: "Foo", message: "No region named Foo.", suggestions: ["Bar", "Baz"] });
    expect(line).toBe('error code=unknown_target message="No region named Foo." suggestions=Bar,Baz');
  });
});

describe("renderStatsLlm", () => {
  it("emits nodes/edges lines, dropping zero-count kinds", () => {
    const lines = renderStatsLlm({
      nodes: { total: 100, byKind: [{ kind: "method", count: 60 }, { kind: "class", count: 0 }] },
      edges: { total: 50, byPredicate: [{ predicate: "CALLS", count: 50 }, { predicate: "EXTENDS", count: 0 }] },
    });
    expect(lines).toEqual(["nodes total=100 method=60", "edges total=50 CALLS=50"]);
  });
});

describe("renderSmellsLlm", () => {
  it("renders a detection run, highest confidence first, dropping chunks=0", () => {
    const lines = renderSmellsRunLlm({
      rev: 9, run_at: "", count: 2,
      candidates: [
        { file_id: "a", file: "low.py", smell: "has_smell.orphan_file", confidence: 0.5, signals: { connectivity: 0 }, inference_version: "smell_v1" },
        { file_id: "b", file: "big.ts", smell: "has_smell.god_module", confidence: 0.9, signals: { chunks: 0, fan_in: 23, fan_out: 2 }, inference_version: "smell_v1" },
      ],
    });
    expect(lines[0]).toBe("smells rev=9 count=2 version=smell_v1");
    expect(lines[1]).toBe("smell kind=has_smell.god_module file=big.ts confidence=0.9 fan_in=23 fan_out=2");
    expect(lines[1]).not.toContain("chunks=");
    expect(lines[2]).toBe("smell kind=has_smell.orphan_file file=low.py confidence=0.5 connections=0");
  });
  it("renders --list claims", () => {
    const lines = renderSmellsListLlm([{ smell: "has_smell.god_module", entity_id: "abcdef0123456789", confidence: 0.7, inference_version: "smell_v1" }]);
    expect(lines[0]).toBe("smells count=1 version=smell_v1");
    expect(lines[1]).toBe("smell kind=has_smell.god_module entity=abcdef012345 confidence=0.7 version=smell_v1");
  });
});

describe("impact llm helpers", () => {
  const risk = {
    riskLevel: "high", category: "boundary", riskSummary: "Auth check; 14 sites",
    behaviorAtRisk: ["Token validation"], nextStep: "Run callers", flowPropagation: undefined,
  } as any;
  it("impactHeaderLlm emits impact + behavior lines with quoted summary and comma system_path", () => {
    const lines = impactHeaderLlm({ kind: "function", name: "verify_token" }, risk, [{ name: "Auth", kind: "subsystem" }, { name: "Core", kind: "system" }]);
    expect(lines[0]).toBe('impact target=verify_token kind=function risk=high category=boundary system_path=Auth,Core summary="Auth check; 14 sites"');
    expect(lines[1]).toBe('behavior text="Token validation"');
  });
  it("impactPropagationLlm sorts buckets by member count and emits flow first", () => {
    const lines = impactPropagationLlm(
      [{ region: { name: "small", kind: "module" }, members: [1] }, { region: { name: "big", kind: "subsystem" }, members: [1, 2, 3] }],
      { flowName: "request", count: 9 },
    );
    expect(lines[0]).toBe("flow name=request count=9");
    // humanizeLabel turns "big" into "big layer" (then quoted for the space)
    expect(lines[1]).toBe('bucket region="big layer" kind=subsystem count=3');
    expect(lines[2]).toBe('bucket region="small layer" kind=module count=1');
  });
  it("impactTailLlm emits next/decision/task/bug records", () => {
    const lines = impactTailLlm(risk, [{ name: "Use JWT" }], [{ name: "Migrate", status: "open" }], [{ name: "Leak", status: "open", severity: "high" }]);
    expect(lines).toEqual([
      'next text="Run callers"',
      'decision name="Use JWT"',
      "task name=Migrate status=open",
      "bug name=Leak status=open severity=high",
    ]);
  });
});

describe("overview llm helpers", () => {
  it("overviewContainerLlm emits overview + contains + item + note", () => {
    const lines = overviewContainerLlm({
      target: { name: "IngestionService", kind: "class" }, displayPath: "src/ingest.ts",
      systemPath: [{ name: "Ingestion", kind: "system" }, { name: "Core", kind: "subsystem" }], hasMap: true,
      childrenByKind: { method: 12, field: 4 }, keyItems: [{ name: "parseFile", kind: "method" }],
      diagnostics: ["No system map."],
    });
    expect(lines[0]).toBe("overview target=IngestionService kind=class file=src/ingest.ts system_path=Ingestion,Core");
    expect(lines[1]).toBe("contains method=12 field=4");
    expect(lines[2]).toBe("item name=parseFile kind=method");
    expect(lines[3]).toBe('note text="No system map."');
  });
  it("overviewLeafLlm emits contained_in and nearby/sibling, dropping absent system_path", () => {
    const lines = overviewLeafLlm({
      target: { name: "verify", kind: "function" }, displayPath: "auth.ts",
      containedIn: { kind: "class", name: "Auth" }, systemPath: [], hasMap: false,
      siblingsByKind: { method: 3 }, keySiblings: [{ name: "login", kind: "method" }], diagnostics: [],
    });
    expect(lines[0]).toBe('overview target=verify kind=function file=auth.ts contained_in="class Auth"');
    expect(lines[0]).not.toContain("system_path=");
    expect(lines[1]).toBe("nearby method=3");
    expect(lines[2]).toBe("sibling name=login kind=method");
  });
});
