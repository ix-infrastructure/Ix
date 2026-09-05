import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Verify that `ix depends` presents results in dependency direction,
 * uses full-tree traversal, and has correct semantics.
 */

const dependsTsPath = path.resolve(__dirname, "../commands/depends.ts");
const dependsContent = fs.readFileSync(dependsTsPath, "utf-8");

// ── Direction semantics ─────────────────────────────────────────────

describe("depends direction semantics", () => {
  it("description says upstream dependents", () => {
    expect(dependsContent).toContain("upstream dependents");
    expect(dependsContent).not.toContain("reverse CALLS");
  });

  it("text heading uses dependency-oriented language", () => {
    expect(dependsContent).toContain("Dependents");
  });

  it("empty state message uses dependency language", () => {
    expect(dependsContent).toContain("No upstream dependents found");
  });

  it("uses dependency-oriented relation values", () => {
    expect(dependsContent).toContain('"called_by"');
    expect(dependsContent).toContain('"imported_by"');
  });
});

// ── Full-tree traversal ─────────────────────────────────────────────

describe("depends full-tree traversal", () => {
  it("has buildDependencyTree function", () => {
    expect(dependsContent).toContain("buildDependencyTree");
  });

  it("expands recursively via one-hop calls", () => {
    // Uses hops: 1 for each level, then recurses
    expect(dependsContent).toContain("hops: 1");
    expect(dependsContent).toContain("await expand(n.id, depth + 1)");
  });

  it("defaults to full traversal without --depth", () => {
    // --depth has no default value in option declaration
    expect(dependsContent).toContain('depth?: string');
    expect(dependsContent).toContain("DEFAULT_MAX_DEPTH");
  });

  it("--depth acts as optional limiter", () => {
    expect(dependsContent).toContain('"--depth <n>"');
    expect(dependsContent).toContain("Cap traversal depth");
  });

  it("has cycle detection", () => {
    expect(dependsContent).toContain("visited.has(n.id)");
    expect(dependsContent).toContain("cycle: true");
  });

  it("has node cap safety limit", () => {
    expect(dependsContent).toContain("MAX_NODES");
    expect(dependsContent).toContain("nodesVisited >= maxNodes");
  });

  it("reports truncation when limits hit", () => {
    expect(dependsContent).toContain("truncated = true");
    expect(dependsContent).toContain("tree truncated");
  });
});

// ── Nested tree output ──────────────────────────────────────────────

describe("depends nested tree structure", () => {
  it("has DependencyNode interface with children", () => {
    expect(dependsContent).toContain("interface DependencyNode");
    expect(dependsContent).toContain("children: DependencyNode[]");
  });

  it("JSON outputs tree field not flat results", () => {
    expect(dependsContent).toContain("tree,");
    expect(dependsContent).not.toMatch(/\bresults: allDependents\.map\b/);
  });

  it("JSON includes traversal metadata", () => {
    expect(dependsContent).toContain("nodesVisited");
    expect(dependsContent).toContain("maxDepthReached");
    expect(dependsContent).toContain("truncated");
  });

  it("renders text tree with box-drawing glyphs", () => {
    expect(dependsContent).toContain("└─");
    expect(dependsContent).toContain("├─");
    expect(dependsContent).toContain("│");
  });

  it("JSON includes semantics field", () => {
    expect(dependsContent).toContain('"downstream_dependents"');
  });
});

// ── Input validation ────────────────────────────────────────────────

describe("depends input validation", () => {
  it("validates --pick as positive integer", () => {
    expect(dependsContent).toContain("parsePickOption");
  });

  it("supports --pick option", () => {
    expect(dependsContent).toContain('"--pick <n>"');
  });

  it("supports --kind option", () => {
    expect(dependsContent).toContain('"--kind <kind>"');
  });

  it("supports --path option", () => {
    expect(dependsContent).toContain('"--path <path>"');
  });

  it("supports --format option", () => {
    expect(dependsContent).toContain('"--format <fmt>"');
  });

  it("uses resolveFileOrReport with resolveOpts", () => {
    expect(dependsContent).toContain("resolveFileOrReport(client, symbol, resolveOpts, opts.format)");
  });

  it("traverses edges in reverse via predicate map", () => {
    expect(dependsContent).toContain('direction: "in"');
    expect(dependsContent).toContain("predicates: [p]");
    expect(dependsContent).toContain("CALLS");
    expect(dependsContent).toContain("IMPORTS");
  });
});
