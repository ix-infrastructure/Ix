// Copyright 2026 Ix Infrastructure INC

import { describe, expect, it } from "vitest";

import { selectWorkspaceForCwd, type WorkspaceConfig } from "../config.js";

function workspace(rootPath: string, name = rootPath): WorkspaceConfig {
  return {
    workspace_id: name,
    workspace_name: name,
    root_path: rootPath,
    default: false,
  };
}

describe("workspace path matching", () => {
  it("matches a workspace root and its descendants", () => {
    const candidate = workspace("/work/app", "app");

    expect(selectWorkspaceForCwd([candidate], "/work/app")).toBe(candidate);
    expect(selectWorkspaceForCwd([candidate], "/work/app/src/features")).toBe(candidate);
  });

  it("does not match a sibling whose name only shares the root prefix", () => {
    const candidate = workspace("/work/app", "app");

    expect(selectWorkspaceForCwd([candidate], "/work/app-copy")).toBeUndefined();
    expect(selectWorkspaceForCwd([candidate], "/work/application")).toBeUndefined();
  });

  it("selects the nearest workspace when roots are nested", () => {
    const parent = workspace("/work/app", "parent");
    const child = workspace("/work/app/packages/api", "child");

    expect(selectWorkspaceForCwd([parent, child], "/work/app/packages/api/src")).toBe(child);
  });
});
