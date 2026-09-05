import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { parse } from "yaml";

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
  // workspace_id MUST be quoted. It is 8 hex chars, so ~3.7% of ids are
  // numeric-looking to YAML. loadConfig's String() normalization round-trips
  // an integer that reprints identically ("12345678"), but not the other
  // ~1.6% — "709e7420" parses as Infinity, and "01311916" comes back 1311916
  // with the leading zero gone — because the original text is lost once the
  // parser has coerced the value. An unquoted fixture then fires a spurious
  // migration and fails "does NOT migrate" at that 1.6%.
  // saveConfig (yaml.stringify) quotes these for real, so quoting here is
  // also what makes the fixture faithful to a config the CLI actually wrote.
  const body = "endpoint: http://localhost:8090\n" +
    "workspaces:\n" +
    workspaces.map((w: any) =>
      `  - workspace_id: "${w.workspace_id}"\n    workspace_name: ${w.workspace_name}\n    root_path: ${w.root_path}\n    default: ${w.default ?? false}\n`).join("");

  // Enforce it rather than trusting the template. Two checks, deliberately:
  //
  // The text check fires 100% of the time, because it does not depend on which
  // id this run's temp path happened to produce. Checking only the parsed value
  // would fire solely on ids YAML coerces -- self-diagnosing when it happens,
  // but still a heisenbug, and silent on the run that reintroduces the quoting
  // mistake.
  workspaces.forEach((w: any) => {
    expect(body, "workspace_id must be quoted in the fixture").toContain(`workspace_id: "${w.workspace_id}"`);
  });

  // And the parse check, which catches the wider class: any field whose value
  // YAML would reinterpret (a workspace_name of `true`, `007` or `null`).
  // Compared strictly, NOT via String() on both sides -- that would cancel out
  // exactly the boolean and null coercions, the ones with real consequences,
  // since loadConfig normalizes workspace_id but never workspace_name.
  const parsed = parse(body) as { workspaces?: { workspace_id: unknown; workspace_name: unknown }[] };
  (parsed.workspaces ?? []).forEach((w, i) => {
    expect(typeof w.workspace_id, "workspace_id must survive YAML as a string").toBe("string");
    expect(w.workspace_id).toBe((workspaces[i] as any).workspace_id);
    expect(w.workspace_name, "workspace_name must survive YAML unchanged").toBe((workspaces[i] as any).workspace_name);
  });

  fs.writeFileSync(nodePath.join(home, ".ix", "config.yaml"), body);
}

function readWorkspaceId(rootPath: string): string | undefined {
  const raw = fs.readFileSync(nodePath.join(home, ".ix", "config.yaml"), "utf8");
  // crude: find the block for rootPath and read its workspace_id
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("workspace_id:")) {
      // Strip surrounding quotes: YAML quotes an all-digit id (e.g. "62868610")
      // to keep it a string, and this crude reader must match the parsed value.
      const id = lines[i].split("workspace_id:")[1].trim().replace(/^["']|["']$/g, "");
      for (let j = i; j < i + 4 && j < lines.length; j++) {
        if (lines[j].includes("root_path:") && lines[j].includes(rootPath)) return id;
      }
    }
  }
  return undefined;
}

describe("workspace_id migration (Ix#225 gap 2)", () => {
  it.skipIf(process.platform === "win32")("normalizes an equivalent registered root instead of duplicating it", () => {
    const root = nodePath.join(home, "repoLinked");
    const linked = nodePath.join(home, "repoAlias");
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(root, linked, "dir");
    const canonicalRoot = fs.realpathSync.native(root);
    const pathId = workspaceIdForPath(canonicalRoot);
    writeConfig([{ workspace_id: pathId, workspace_name: "repoLinked", root_path: linked, default: true }]);

    const state = ensureWorkspaceIdState(root);
    const config = parse(fs.readFileSync(nodePath.join(home, ".ix", "config.yaml"), "utf8")) as {
      workspaces: { root_path: string }[];
    };

    expect(state.migrated).toBe(false);
    expect(config.workspaces).toHaveLength(1);
    expect(config.workspaces[0].root_path).toBe(canonicalRoot);
  });

  it("re-keys a legacy random workspace_id to the path-based id and reports migrated", () => {
    const root = nodePath.join(home, "repoOne");
    fs.mkdirSync(root, { recursive: true });
    writeConfig([{ workspace_id: "rand0001", workspace_name: "repoOne", root_path: root, default: true }]);

    const canonicalRoot = fs.realpathSync.native(root);
    const pathId = workspaceIdForPath(canonicalRoot);
    expect(pathId).not.toBe("rand0001");

    const state = ensureWorkspaceIdState(root);
    expect(state.workspaceId).toBe(pathId);
    expect(state.migrated).toBe(true);
    expect(state.previousWorkspaceId).toBe("rand0001"); // captured for orphan cleanup
    expect(readWorkspaceId(canonicalRoot)).toBe(pathId); // persisted
  });

  it("does NOT migrate (or churn) a workspace already on the path-based id", () => {
    const root = nodePath.join(home, "repoTwo");
    fs.mkdirSync(root, { recursive: true });
    const pathId = workspaceIdForPath(fs.realpathSync.native(root));
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
    expect(state.workspaceId).toBe(workspaceIdForPath(fs.realpathSync.native(root)));
    expect(state.migrated).toBe(false);
  });
});
