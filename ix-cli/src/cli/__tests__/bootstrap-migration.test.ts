import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { ensureWorkspaceIdState } from "../bootstrap.js";
import { workspaceIdForPath } from "../system.js";

// Isolate ~/.ix by pointing HOME/USERPROFILE at a temp dir per test.
let home: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-bootmig-"));
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.mkdirSync(nodePath.join(home, ".ix"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedProfile;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeConfig(workspaces: object[]) {
  const body = "endpoint: http://localhost:8090\n" +
    "workspaces:\n" +
    workspaces.map((w: any) =>
      `  - workspace_id: ${w.workspace_id}\n    workspace_name: ${w.workspace_name}\n    root_path: ${w.root_path}\n    default: ${w.default ?? false}\n`).join("");
  fs.writeFileSync(nodePath.join(home, ".ix", "config.yaml"), body);
}

function readWorkspaceId(rootPath: string): string | undefined {
  const raw = fs.readFileSync(nodePath.join(home, ".ix", "config.yaml"), "utf8");
  // crude: find the block for rootPath and read its workspace_id
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("workspace_id:")) {
      const id = lines[i].split("workspace_id:")[1].trim();
      for (let j = i; j < i + 4 && j < lines.length; j++) {
        if (lines[j].includes("root_path:") && lines[j].includes(rootPath)) return id;
      }
    }
  }
  return undefined;
}

describe("workspace_id migration (Ix#225 gap 2)", () => {
  it("re-keys a legacy random workspace_id to the path-based id and reports migrated", () => {
    const root = nodePath.join(home, "repoOne");
    fs.mkdirSync(root, { recursive: true });
    writeConfig([{ workspace_id: "rand0001", workspace_name: "repoOne", root_path: root, default: true }]);

    const pathId = workspaceIdForPath(root);
    expect(pathId).not.toBe("rand0001");

    const state = ensureWorkspaceIdState(root);
    expect(state.workspaceId).toBe(pathId);
    expect(state.migrated).toBe(true);
    expect(readWorkspaceId(root)).toBe(pathId); // persisted
  });

  it("does NOT migrate (or churn) a workspace already on the path-based id", () => {
    const root = nodePath.join(home, "repoTwo");
    fs.mkdirSync(root, { recursive: true });
    const pathId = workspaceIdForPath(root);
    writeConfig([{ workspace_id: pathId, workspace_name: "repoTwo", root_path: root, default: true }]);

    const state = ensureWorkspaceIdState(root);
    expect(state.workspaceId).toBe(pathId);
    expect(state.migrated).toBe(false);
  });

  it("creates a fresh workspace with the path-based id (not random), not flagged migrated", () => {
    const root = nodePath.join(home, "repoThree");
    fs.mkdirSync(root, { recursive: true });
    writeConfig([]); // no workspaces yet

    const state = ensureWorkspaceIdState(root);
    expect(state.workspaceId).toBe(workspaceIdForPath(root));
    expect(state.migrated).toBe(false);
  });
});
