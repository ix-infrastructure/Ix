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

/** A directory is its own git repository iff it contains a `.git` entry (a dir
 *  for a normal clone, or a file for a submodule/worktree). This is the
 *  ground-truth signal that a child is a DISTINCT repository — a monorepo's
 *  package dirs never have their own .git (they share the root's). */
function hasOwnGit(dir: string): boolean {
  try { return fs.existsSync(nodePath.join(dir, ".git")); } catch { return false; }
}

/**
 * True if `dir` declares itself the root of a single multi-package project (a
 * monorepo / workspace), independent of git. Covers the case where a monorepo is
 * mapped without its .git (a downloaded tarball/zip): the workspace config is an
 * explicit "these subdirs are MY packages, not separate repos" declaration.
 */
function hasWorkspaceMarker(dir: string): boolean {
  const has = (f: string) => { try { return fs.existsSync(nodePath.join(dir, f)); } catch { return false; } };
  const reads = (f: string): string | null => { try { return fs.readFileSync(nodePath.join(dir, f), "utf8"); } catch { return null; } };
  // Dedicated workspace/monorepo config files.
  if (has("pnpm-workspace.yaml") || has("lerna.json") || has("nx.json") ||
      has("turbo.json") || has("rush.json") || has("go.work") ||
      has("WORKSPACE") || has("WORKSPACE.bazel") || has("MODULE.bazel")) return true;
  // package.json with a `workspaces` field (npm / yarn / bun workspaces).
  const pkg = reads("package.json");
  if (pkg) { try { if ("workspaces" in (JSON.parse(pkg) as Record<string, unknown>)) return true; } catch { /* ignore */ } }
  // Cargo workspace.
  const cargo = reads("Cargo.toml");
  if (cargo && /^\s*\[workspace\]/m.test(cargo)) return true;
  // Maven multi-module / Gradle multi-project.
  const pom = reads("pom.xml");
  if (pom && /<modules>/.test(pom)) return true;
  const settings = reads("settings.gradle") ?? reads("settings.gradle.kts");
  if (settings && /\binclude\b/.test(settings)) return true;
  return false;
}

/** True if `dir` or any ancestor is a single repository: a git repo root (.git)
 *  OR a declared monorepo/workspace root. Used to tell a monorepo's package dir
 *  (part of ONE repo) from a plain folder that collects independently-cloned
 *  repos. */
function isInsideSingleRepo(dir: string): boolean {
  let cur = nodePath.resolve(dir);
  // Walk up to the filesystem root, checking each level.
  while (true) {
    if (hasOwnGit(cur) || hasWorkspaceMarker(cur)) return true;
    const parent = nodePath.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * Published package name(s) for a member repo, read (pragmatically) from its
 * build manifest. These are matched against other members' imports to derive the
 * cross-repo dependency graph: a cross-repo edge is only kept when the source
 * repo actually imports the target repo's package. Best-effort per language;
 * a repo with no recognized package name simply contributes no inbound deps.
 */
export function readPackageNames(dir: string): string[] {
  const names = new Set<string>();
  const read = (f: string): string | null => {
    try { return fs.readFileSync(nodePath.join(dir, f), "utf8"); } catch { return null; }
  };
  const add = (n: unknown) => { if (typeof n === "string" && n.trim()) names.add(n.trim()); };

  const pkg = read("package.json");                                  // JS / TS
  if (pkg) { try { add(JSON.parse(pkg).name); } catch { /* ignore */ } }

  const cargo = read("Cargo.toml");                                   // Rust
  if (cargo) {
    const sect = cargo.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
    const m = (sect?.[1] ?? cargo).match(/\bname\s*=\s*"([^"]+)"/);
    if (m) add(m[1]);
  }

  const gomod = read("go.mod");                                       // Go
  if (gomod) { const m = gomod.match(/^\s*module\s+(\S+)/m); if (m) add(m[1]); }

  const pyproj = read("pyproject.toml");                              // Python (PEP 621 / poetry)
  if (pyproj) {
    const sect = pyproj.match(/\[(?:project|tool\.poetry)\]([\s\S]*?)(?:\n\[|$)/);
    const m = (sect?.[1] ?? pyproj).match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (m) add(m[1]);
  }
  const setuppy = read("setup.py");
  if (setuppy) { const m = setuppy.match(/name\s*=\s*["']([^"']+)["']/); if (m) add(m[1]); }
  const setupcfg = read("setup.cfg");
  if (setupcfg) { const m = setupcfg.match(/^\s*name\s*=\s*(\S+)/m); if (m) add(m[1]); }

  const mix = read("mix.exs");                                        // Elixir
  if (mix) { const m = mix.match(/app:\s*:(\w+)/); if (m) add(m[1]); }

  const pom = read("pom.xml");                                        // Java / Maven
  if (pom) {
    // The module's OWN artifactId is a direct <project> child; it must not be
    // shadowed by the <parent> ref or by a <dependency>'s artifactId, so strip
    // those sections before taking the first artifactId.
    const stripped = pom
      .replace(/<parent>[\s\S]*?<\/parent>/g, "")
      .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
      .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "")
      .replace(/<build>[\s\S]*?<\/build>/g, "");
    const m = stripped.match(/<artifactId>([^<]+)<\/artifactId>/);
    if (m) add(m[1]);
  }

  try {                                                               // Ruby gemspec
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".gemspec")) continue;
      const m = read(f)?.match(/\.name\s*=\s*["']([^"']+)["']/);
      if (m) add(m[1]);
    }
  } catch { /* ignore */ }

  return [...names];
}

const PACKAGE_SOURCE_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|rs|go|rb|java|ex|exs|c|h|cc|cpp|hpp|cs|scala|kt|swift)$/i;

/**
 * Resolve an import/dependency identifier to the member repo that publishes it,
 * using the registry. Single source of truth shared by the import-matching gate
 * (packageOf) and the declared-dependency graph. Rejects relative specifiers and
 * source-file paths; treats a single ':' as a protocol (node:fs) not a package
 * boundary, only Rust's '::' (tokio::sync) is. Matches exact, lowercased stem,
 * then a package-boundary prefix (scoped/sub-path/sub-module imports).
 */
export function lookupPackage(registry: Record<string, string>, mod: string): string | undefined {
  if (!mod) return undefined;
  if (mod.startsWith(".") || mod.startsWith("/")) return undefined;
  if (PACKAGE_SOURCE_EXT.test(mod)) return undefined;
  if (registry[mod]) return registry[mod];
  const lower = mod.toLowerCase();
  if (registry[lower]) return registry[lower];
  for (const pkg in registry) {
    if (mod.length > pkg.length && mod.startsWith(pkg)) {
      const sep = mod[pkg.length];
      if (sep === "/" || sep === ".") return registry[pkg];
      if (sep === ":" && mod[pkg.length + 1] === ":") return registry[pkg];
    }
  }
  return undefined;
}

/**
 * Declared dependency identifiers from a member's build manifest (the ground-truth
 * dependency graph). Parsed per ecosystem: npm dependencies, Cargo [dependencies],
 * go.mod require, Maven <dependency> artifactIds, Gradle, pyproject/poetry. These
 * are matched against member published names to build the inter-repo dep graph,
 * which is more robust than inferring deps from import matching alone (e.g. Java's
 * Maven artifactId never appears in `import com.google.common.*`).
 */
export function readPackageDeps(dir: string): string[] {
  const deps = new Set<string>();
  const read = (f: string): string | null => {
    try { return fs.readFileSync(nodePath.join(dir, f), "utf8"); } catch { return null; }
  };
  const add = (n: unknown) => { if (typeof n === "string" && n.trim()) deps.add(n.trim()); };

  // PRODUCTION deps only. The declared-dependency graph gates cross-repo edges,
  // i.e. it asserts "repo A's code genuinely depends on repo B's code." dev/test
  // and build-tool deps are NOT production architecture: every repo dev-depends on
  // its test/build tooling, and treating those as coupling falsely merges
  // unrelated repos into one system (e.g. express dev-depends on morgan only for
  // its tests; chalk dev-depends on execa; lodash dev-depends on chalk) and lets
  // symbol-name collisions slip the gate. So devDependencies / Cargo
  // [dev-dependencies] / [build-dependencies] are intentionally excluded; runtime
  // peer/optional deps are kept (they are real runtime coupling).
  const pkg = read("package.json");                                  // JS / TS
  if (pkg) { try {
    const j = JSON.parse(pkg);
    for (const s of ["dependencies", "peerDependencies", "optionalDependencies"])
      if (j[s] && typeof j[s] === "object") for (const k of Object.keys(j[s])) add(k);
  } catch { /* ignore */ } }

  const cargo = read("Cargo.toml");                                  // Rust
  if (cargo) {
    // Match [dependencies], [dependencies.x], [target.'cfg'.dependencies], but
    // skip [dev-dependencies] / [build-dependencies] (not runtime coupling).
    for (const sect of cargo.matchAll(/\[([^\]\n]*\bdependencies\b[^\]\n]*)\]([\s\S]*?)(?:\n\[|$)/g)) {
      if (/\b(?:dev|build)-dependencies\b/.test(sect[1])) continue;
      for (const dm of sect[2].matchAll(/^\s*([A-Za-z0-9_-]+)\s*(?:=|\.)/gm)) add(dm[1]);
    }
  }

  const gomod = read("go.mod");                                      // Go
  if (gomod) {
    for (const m of gomod.matchAll(/^\s*require\s+(\S+)\s+v/gm)) add(m[1]);
    for (const blk of gomod.matchAll(/require\s*\(([\s\S]*?)\)/g))
      for (const dm of blk[1].matchAll(/^\s*(\S+)\s+v/gm)) add(dm[1]);
  }

  const pom = read("pom.xml");                                       // Java / Maven
  if (pom) for (const m of pom.matchAll(/<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g)) add(m[1]);

  const gradle = read("build.gradle") ?? read("build.gradle.kts");   // Java / Kotlin / Gradle
  if (gradle) {
    for (const m of gradle.matchAll(/project\(['"]:?([^'"]+)['"]\)/g)) add(m[1].split(":").pop());
    for (const m of gradle.matchAll(/['"][\w.-]+:([\w.-]+):[^'"]+['"]/g)) add(m[1]);
  }

  const pyproj = read("pyproject.toml");                             // Python
  if (pyproj) {
    for (const m of pyproj.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*(?:[><=~!^]|=\s*["'])/gm)) add(m[1]);
    for (const blk of pyproj.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g))
      for (const dm of blk[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)) add(dm[1]);
  }

  return [...deps];
}

/**
 * package identifier -> member repo dir (the repo_id), for cross-repo dep
 * detection. Indexed by BOTH the full package name (`@babel/types`,
 * `github.com/org/repo`) AND its lowercased stem (`types`, `repo`), because the
 * parser records import targets as stems. Ambiguous stems (shared by >1 member)
 * are dropped so a stem never maps to the wrong repo.
 */
export function buildPackageRegistry(rootPath: string, members: string[]): Record<string, string> {
  const reg: Record<string, string> = {};
  const stemOwners = new Map<string, Set<string>>();
  const stemRepo = new Map<string, string>();
  // Underscore-normalized aliases: Cargo turns a package name's hyphens into
  // underscores for the crate identifier used in code (Cargo `grep-matcher` is
  // imported as `grep_matcher`), so the registry must answer to both forms.
  // Harmless for JS (its imports keep the hyphen, matched by the exact name).
  const aliasOwners = new Map<string, Set<string>>();
  const aliasRepo = new Map<string, string>();
  const stemOf = (name: string): string =>
    (name.split(/[/.:]/).filter(Boolean).pop() ?? name).toLowerCase();
  for (const m of members) {
    for (const name of readPackageNames(nodePath.join(rootPath, m))) {
      if (!(name in reg)) reg[name] = m;                 // full name (exact)
      const stem = stemOf(name);
      if (!stemOwners.has(stem)) stemOwners.set(stem, new Set());
      stemOwners.get(stem)!.add(m);
      stemRepo.set(stem, m);
      for (const variant of new Set([name.replace(/-/g, '_'), stem.replace(/-/g, '_')])) {
        if (variant !== name && variant !== stem) {
          if (!aliasOwners.has(variant)) aliasOwners.set(variant, new Set());
          aliasOwners.get(variant)!.add(m);
          aliasRepo.set(variant, m);
        }
      }
    }
  }
  for (const [stem, owners] of stemOwners) {
    if (owners.size === 1 && !(stem in reg)) reg[stem] = stemRepo.get(stem)!;  // unambiguous stem
  }
  for (const [alias, owners] of aliasOwners) {
    if (owners.size === 1 && !(alias in reg)) reg[alias] = aliasRepo.get(alias)!;  // unambiguous underscore alias
  }
  return reg;
}

export interface DetectedSystem {
  /** Stable id stamped on every member node/edge; the system-map scope key. */
  systemId: string;
  /** Display name (the directory basename). */
  name: string;
  /** Member repo directory names (immediate children that are repo roots). */
  members: string[];
  /** Published package name -> member repo dir, for cross-repo dependency gating. */
  packageRegistry: Record<string, string>;
  /**
   * Ground-truth inter-member dependency graph (member dir -> member dirs it
   * declares a dependency on), read from each member's manifest dependency list
   * and matched to member published names. Seeds the resolver's cross-repo gate
   * so genuine cross-repo edges survive even when import-to-package matching
   * can't bridge the gap (e.g. Java's Maven artifactId vs `com.google.common.*`).
   */
  repoDeps: Record<string, string[]>;
}

/** Member dir -> set of member dirs it declares a dependency on (intra-system only). */
function buildRepoDeps(rootPath: string, members: string[], registry: Record<string, string>): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  for (const m of members) {
    const set = new Set<string>();
    for (const dep of readPackageDeps(nodePath.join(rootPath, m))) {
      const owner = lookupPackage(registry, dep);
      if (owner !== undefined && owner !== m) set.add(owner);
    }
    if (set.size > 0) graph[m] = [...set];
  }
  return graph;
}

/**
 * Returns the detected multi-repo system, or undefined when `rootPath` is a
 * single repository (including a monorepo). The discriminator is GIT PROVENANCE,
 * not directory layout, so `ix map <path>` needs no flags:
 *
 *   - >= 2 immediate children are each their OWN git repo  -> a real multi-repo
 *     system (separately-cloned repos, possibly sharing a lib). Co-ingest them.
 *   - `rootPath` is inside one git repo (a monorepo / single repo) with no
 *     nested git-repo children -> ONE repository. Its package dirs are NOT
 *     separate repos, so they are never split apart (this is what stops a
 *     monorepo like babel from being shredded into 147 "systems").
 *   - `rootPath` is not in any git repo -> fall back to manifest-based members
 *     (a non-git folder that collects several projects).
 */
export function detectSystem(rootPath: string): DetectedSystem | undefined {
  // If the mapped path is within a single repository — a git repo (its own .git
  // or an ancestor's) OR a declared monorepo/workspace root (workspaces,
  // pnpm/lerna/nx/turbo, Cargo [workspace], go.work, Maven modules, ...) — it IS
  // one repo. A monorepo's package dirs, or a repo with submodules, are never
  // split into separate "repos" (the workspace check covers a monorepo mapped
  // without its .git). Only a plain folder that collects independently-cloned
  // repos becomes a multi-repo system.
  if (isInsideSingleRepo(rootPath)) return undefined;
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
  const packageRegistry = buildPackageRegistry(rootPath, members);
  return {
    systemId: stableId(`system:${abs}`),
    name: nodePath.basename(abs),
    members,
    packageRegistry,
    repoDeps: buildRepoDeps(rootPath, members, packageRegistry),
  };
}

/**
 * The canonical, path-based workspace_id for a repo root. A repo gets the SAME
 * id whether it is ingested standalone (`ix map <repo>`) or as a member of a
 * system (`ix map <parent>`), which is exactly what keeps a member's node
 * identity byte-identical across both modes. Single source of truth shared by the
 * solo path (bootstrap.getOrCreateWorkspace) and the co-ingest path
 * (repoWorkspaceIdFor); both MUST agree or solo and co-ingest nodes diverge.
 */
export function workspaceIdForPath(absPath: string): string {
  const abs = nodePath.resolve(absPath).split(nodePath.sep).join("/");
  return stableId(`repo:${abs}`);
}

/**
 * A member repo's stable workspace_id, derived from its absolute path so it is
 * independent of which system it sits in (Path-2 friendly) and stable across
 * re-ingests of the same location.
 */
export function repoWorkspaceIdFor(rootPath: string, repoDir: string): string {
  return workspaceIdForPath(nodePath.resolve(rootPath, repoDir));
}
