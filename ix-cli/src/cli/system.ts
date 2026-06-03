import * as fs from "node:fs";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";

/**
 * Multi-repo system auto-detection (Ix#225 Path 1).
 *
 * A directory is treated as a "system" of repos when >= 2 of its immediate child
 * directories are themselves repo roots (a `.git` dir, or a top-level build
 * manifest). Each such child becomes a member repo: it keeps its own stable
 * workspace_id, all members share the system_id, and they map together. A single
 * repo (children are plain source dirs like src/, lib/) is NOT a system and
 * ingests exactly as before. No flag — `ix map <dir>` just does the right thing.
 */

// Strong, top-level build/package manifests. Deliberately excludes things that
// commonly appear in ordinary subdirectories (Makefile, requirements.txt) to
// avoid misreading a single repo's subfolders as member repos.
const REPO_MANIFESTS = new Set([
  "package.json", "go.mod", "go.work", "Cargo.toml", "pom.xml",
  "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "pyproject.toml", "setup.py", "composer.json", "Gemfile", "build.sbt",
  "CMakeLists.txt", "mix.exs", "pubspec.yaml", "Package.swift",
]);

const stableId = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 8);

function isRepoRoot(dir: string): boolean {
  try {
    if (fs.existsSync(nodePath.join(dir, ".git"))) return true;
    for (const e of fs.readdirSync(dir)) {
      if (REPO_MANIFESTS.has(e) || e.endsWith(".csproj") || e.endsWith(".sln")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface DetectedSystem {
  /** Stable id stamped on every member node/edge; the system-map scope key. */
  systemId: string;
  /** Display name (the directory basename). */
  name: string;
  /** Member repo directory names (immediate children that are repo roots). */
  members: string[];
}

/** Returns the detected system, or undefined when `rootPath` is a single repo. */
export function detectSystem(rootPath: string): DetectedSystem | undefined {
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const members = children
    .filter(c => (c.isDirectory() || c.isSymbolicLink()) && !c.name.startsWith("."))
    .filter(c => isRepoRoot(nodePath.join(rootPath, c.name)))
    .map(c => c.name);
  if (members.length < 2) return undefined;
  const abs = nodePath.resolve(rootPath).split(nodePath.sep).join("/");
  return { systemId: stableId(`system:${abs}`), name: nodePath.basename(abs), members };
}

/**
 * A member repo's stable workspace_id, derived from its absolute path so it is
 * independent of which system it sits in (Path-2 friendly) and stable across
 * re-ingests of the same location.
 */
export function repoWorkspaceIdFor(rootPath: string, repoDir: string): string {
  const abs = nodePath.resolve(rootPath, repoDir).split(nodePath.sep).join("/");
  return stableId(`repo:${abs}`);
}
