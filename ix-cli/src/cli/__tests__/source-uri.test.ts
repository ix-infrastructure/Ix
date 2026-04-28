import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Redirect ~/.ix and cwd-resolution into a tmp tree so resolveWorkspaceRoot
// has something deterministic to find.
const tmpHome = mkdtempSync(join(tmpdir(), "ix-source-uri-test-"));
const tmpWs = mkdtempSync(join(tmpdir(), "ix-source-uri-ws-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => tmpHome };
});

import {
  absoluteFromSourceUri,
  saveConfig,
  type IxConfig,
  type WorkspaceConfig,
} from "../config.js";

beforeEach(() => {
  const ws: WorkspaceConfig = {
    workspace_id: "test-ws",
    workspace_name: "test",
    root_path: tmpWs,
    default: true,
  };
  const cfg: IxConfig = {
    endpoint: "http://localhost:8090",
    format: "text",
    workspaces: [ws],
  };
  saveConfig(cfg);
});

afterEach(() => {
  // Clean any subdir test artifacts; tmp dirs themselves persist for the run.
});

describe("absoluteFromSourceUri", () => {
  // Bug 1: The original implementation used `require("node:path")` inside an
  // ESM module, which throws ReferenceError at runtime. This test calls the
  // function — if `require` returns, the test fails with a clear error.
  it("does not throw ReferenceError in ESM scope", () => {
    expect(() => absoluteFromSourceUri("src/foo.ts", tmpWs)).not.toThrow();
  });

  it("resolves a workspace-relative path against an explicit root", () => {
    const out = absoluteFromSourceUri("src/foo.ts", tmpWs);
    expect(out).toBe(join(tmpWs, "src", "foo.ts"));
  });

  it("returns POSIX-absolute input unchanged", () => {
    const abs = "/abs/path/foo.ts";
    expect(absoluteFromSourceUri(abs, tmpWs)).toBe(abs);
  });

  it("returns Windows-absolute input unchanged", () => {
    const winAbs = "C:\\Users\\foo\\bar.ts";
    expect(absoluteFromSourceUri(winAbs, tmpWs)).toBe(winAbs);
  });

  it("returns empty input unchanged", () => {
    expect(absoluteFromSourceUri("", tmpWs)).toBe("");
  });

  it("normalizes Windows path separators in relative input", () => {
    const out = absoluteFromSourceUri("src\\foo.ts", tmpWs);
    expect(out).toBe(join(tmpWs, "src", "foo.ts"));
  });

  it("falls back to the configured workspace when no explicit root is given", () => {
    const out = absoluteFromSourceUri("src/foo.ts");
    expect(out).toBe(join(tmpWs, "src", "foo.ts"));
  });
});
