// Copyright 2026 Ix Infrastructure Inc.

import { describe, it, expect } from "vitest";
import { applyPathFilters, applyKindExclusion, getSourceUri, pluralize } from "../commands/rank.js";

describe("getSourceUri", () => {
  it("extracts from provenance.sourceUri", () => {
    expect(getSourceUri({ provenance: { sourceUri: "src/auth.ts" } })).toBe("src/auth.ts");
  });

  it("extracts from provenance.source_uri", () => {
    expect(getSourceUri({ provenance: { source_uri: "src/auth.ts" } })).toBe("src/auth.ts");
  });

  it("extracts from attrs.sourceUri", () => {
    expect(getSourceUri({ attrs: { sourceUri: "src/auth.ts" } })).toBe("src/auth.ts");
  });

  it("extracts from attrs.source_uri", () => {
    expect(getSourceUri({ attrs: { source_uri: "src/auth.ts" } })).toBe("src/auth.ts");
  });

  it("returns empty string when no URI found", () => {
    expect(getSourceUri({})).toBe("");
    expect(getSourceUri({ attrs: {} })).toBe("");
  });
});

describe("applyPathFilters", () => {
  const nodes = [
    { id: "1", kind: "class", provenance: { sourceUri: "src/auth/service.ts" } },
    { id: "2", kind: "class", provenance: { sourceUri: "src/api/handler.ts" } },
    { id: "3", kind: "class", provenance: { sourceUri: "test/auth/service.test.ts" } },
    { id: "4", kind: "class", provenance: { sourceUri: "test/resources/fixture.ts" } },
  ];

  it("includes only matching paths", () => {
    const result = applyPathFilters(nodes, "src/auth");
    expect(result.map((n: any) => n.id)).toEqual(["1"]);
  });

  it("excludes matching paths", () => {
    const result = applyPathFilters(nodes, undefined, "test");
    expect(result.map((n: any) => n.id)).toEqual(["1", "2"]);
  });

  it("applies both include and exclude", () => {
    const result = applyPathFilters(nodes, "auth", "test");
    expect(result.map((n: any) => n.id)).toEqual(["1"]);
  });

  it("returns all when no filters", () => {
    const result = applyPathFilters(nodes);
    expect(result.length).toBe(4);
  });
});

describe("applyKindExclusion", () => {
  const nodes = [
    { id: "1", kind: "class" },
    { id: "2", kind: "config_entry" },
    { id: "3", kind: "method" },
    { id: "4", kind: "config_entry" },
  ];

  it("excludes specified kinds", () => {
    const result = applyKindExclusion(nodes, ["config_entry"]);
    expect(result.map((n: any) => n.id)).toEqual(["1", "3"]);
  });

  it("excludes multiple kinds", () => {
    const result = applyKindExclusion(nodes, ["config_entry", "method"]);
    expect(result.map((n: any) => n.id)).toEqual(["1"]);
  });

  it("returns all when no exclusions", () => {
    const result = applyKindExclusion(nodes, []);
    expect(result.length).toBe(4);
  });
});

describe("pluralize", () => {
  it("pluralizes regular words", () => {
    expect(pluralize("method")).toBe("methods");
    expect(pluralize("module")).toBe("modules");
    expect(pluralize("function")).toBe("functions");
  });

  it("pluralizes words ending in 's'", () => {
    expect(pluralize("class")).toBe("classes");
  });

  it("pluralizes words ending in 'ss'", () => {
    expect(pluralize("class")).toBe("classes");
  });

  it("pluralizes words ending in 'ch', 'sh', 'x'", () => {
    expect(pluralize("match")).toBe("matches");
    expect(pluralize("index")).toBe("indexes");
  });

  it("pluralizes words ending in consonant + 'y'", () => {
    expect(pluralize("entry")).toBe("entries");
    expect(pluralize("factory")).toBe("factories");
  });

  it("does not change 'y' after vowel", () => {
    expect(pluralize("key")).toBe("keys");
    expect(pluralize("array")).toBe("arrays");
  });
});
