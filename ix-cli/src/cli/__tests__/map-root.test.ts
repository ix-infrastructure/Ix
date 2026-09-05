import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerMapCommand } from "../commands/map.js";
import { canonicalMapRoot, resolveMapRoot } from "../map-root.js";
import { lockPathForTest } from "../single-flight.js";

const fixtures: string[] = [];
let savedHome: string | undefined;
let savedProfile: string | undefined;
let home: string;
let savedExitCode: number | string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  home = fixture();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(join(home, ".ix"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedProfile;
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ix-map-root-"));
  fixtures.push(dir);
  return dir;
}

describe("map root resolution", () => {
  it("resolves an unregistered nested cwd to its git root", () => {
    const root = fixture();
    const nested = join(root, "src", "commands");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });

    expect(resolveMapRoot(undefined, nested)).toBe(realpathSync.native(root));
  });

  // `ix map` writes. A configured workspace outranking the repository the user
  // is standing in means a bare `ix map` re-ingests a tree nothing on screen
  // names -- and rewrites that workspace's map baseline on the way through.
  it("maps the current repository, not the configured named workspace", () => {
    const selected = fixture();
    const repo = fixture();
    const nested = join(repo, "src");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspace: selected",
      "workspaces:",
      "  - workspace_id: selected-id",
      "    workspace_name: selected",
      `    root_path: ${selected}`,
      "    default: false",
      "",
    ].join("\n"));

    expect(resolveMapRoot(undefined, nested)).toBe(realpathSync.native(repo));
  });

  it("maps the current repository, not the default workspace", () => {
    const selected = fixture();
    const repo = fixture();
    const nested = join(repo, "src");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspaces:",
      "  - workspace_id: selected-id",
      "    workspace_name: selected",
      `    root_path: ${selected}`,
      "    default: true",
      "",
    ].join("\n"));

    expect(resolveMapRoot(undefined, nested)).toBe(realpathSync.native(repo));
  });

  it("prefers the registered workspace containing cwd over its git root", () => {
    const repo = fixture();
    const registered = join(repo, "packages", "inner");
    const nested = join(registered, "src");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspaces:",
      "  - workspace_id: inner-id",
      "    workspace_name: inner",
      `    root_path: ${registered}`,
      "    default: true",
      "",
    ].join("\n"));

    expect(resolveMapRoot(undefined, nested)).toBe(realpathSync.native(registered));
  });

  it("falls back to the default workspace when cwd has no local context", () => {
    const selected = fixture();
    const bare = fixture();
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "workspaces:",
      "  - workspace_id: selected-id",
      "    workspace_name: selected",
      `    root_path: ${selected}`,
      "    default: true",
      "",
    ].join("\n"));

    expect(resolveMapRoot(undefined, bare)).toBe(realpathSync.native(selected));
  });

  it.skipIf(process.platform === "win32")("canonicalizes a symlink before deriving workspace identity", () => {
    const root = fixture();
    const real = join(root, "real");
    const linked = join(root, "linked");
    mkdirSync(real);
    symlinkSync(real, linked, "dir");

    expect(canonicalMapRoot(linked)).toBe(realpathSync.native(real));
    expect(lockPathForTest(linked)).toBe(lockPathForTest(real));
  });

  it("rejects a missing path before bootstrap can register it", () => {
    const root = fixture();
    const missing = join(root, "missing");

    expect(() => resolveMapRoot(missing, root)).toThrow(`Map path does not exist: ${missing}`);
  });

  it("reports a missing map path as structured json", async () => {
    const root = fixture();
    const missing = join(root, "missing");
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => output.push(args.join(" ")));
    const program = new Command();
    registerMapCommand(program);

    await program.parseAsync(["node", "ix", "map", missing, "--format", "json"]);

    expect(JSON.parse(output.join("\n"))).toEqual({
      error: "invalid_map_path",
      message: `Map path does not exist: ${missing}`,
    });
    expect(process.exitCode).toBe(1);
  });

  it("rejects a file path before bootstrap can register it", () => {
    const root = fixture();
    const file = join(root, "file.ts");
    writeFileSync(file, "export {};\n");

    expect(() => canonicalMapRoot(file)).toThrow(`Map path is not a directory: ${file}`);
  });
});
