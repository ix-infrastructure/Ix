import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { execFileSync } from "node:child_process";

import { buildPackageRegistry, detectSystem, readPackageNames, readPackageDeps, repoWorkspaceIdFor, workspaceIdForPath } from "../system.js";

// Real on-disk fixtures: buildPackageRegistry reads each member's build manifest.
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-sysreg-"));
  const write = (rel: string, content: string) => {
    const p = nodePath.join(root, rel);
    fs.mkdirSync(nodePath.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  // Rust crate: Cargo name has a hyphen; code imports the underscore form.
  write("grep-matcher/Cargo.toml", '[package]\nname = "grep-matcher"\nversion = "0.1.0"\n');
  write("grep-matcher/src/lib.rs", "pub fn m() {}\n");
  // JS package: scoped, hyphenated; imports keep the hyphen.
  write("app/package.json", '{ "name": "@scope/helper-foo", "version": "1.0.0" }');
  write("app/index.js", "export const x = 1;\n");
  // Maven modules: a library and a dependent module. The dependent's pom has a
  // <parent> ref (must NOT be read as its name) and a <dependency> on the library.
  write("lib/pom.xml",
    '<project><parent><artifactId>acme-parent</artifactId></parent>' +
    '<artifactId>acme-lib</artifactId></project>');
  write("lib/src/main/java/A.java", "package com.acme.lib;\npublic class A {}\n");
  write("consumer/pom.xml",
    '<project><parent><artifactId>acme-parent</artifactId></parent>' +
    '<artifactId>acme-consumer</artifactId>' +
    '<dependencies><dependency><groupId>com.acme</groupId>' +
    '<artifactId>acme-lib</artifactId></dependency></dependencies></project>');
  write("consumer/src/main/java/B.java", "package com.acme.consumer;\nimport com.acme.lib.A;\npublic class B { A a; }\n");
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("buildPackageRegistry", () => {
  it("indexes the Cargo name, its stem, AND the underscore alias (Rust crate id)", () => {
    const reg = buildPackageRegistry(root, ["grep-matcher", "app"]);
    // Cargo hyphen name + its underscore alias both resolve to the rust member.
    expect(reg["grep-matcher"]).toBe("grep-matcher");
    expect(reg["grep_matcher"]).toBe("grep-matcher"); // the fix: `use grep_matcher::...`
    // JS scoped name + stem still resolve; hyphen preserved (no false underscore-only entry needed).
    expect(reg["@scope/helper-foo"]).toBe("app");
    expect(reg["helper-foo"]).toBe("app");
    expect(reg["helper_foo"]).toBe("app"); // alias also present, harmless for JS
  });

  it("detectSystem recognizes all members", () => {
    const d = detectSystem(root);
    expect(d).toBeTruthy();
    expect(d!.members.sort()).toEqual(["app", "consumer", "grep-matcher", "lib"]);
  });
});

describe("Maven name + declared-dependency graph", () => {
  it("reads the module's OWN artifactId, not the <parent> ref", () => {
    expect(readPackageNames(nodePath.join(root, "lib"))).toContain("acme-lib");
    expect(readPackageNames(nodePath.join(root, "consumer"))).toContain("acme-consumer");
    expect(readPackageNames(nodePath.join(root, "consumer"))).not.toContain("acme-parent");
  });

  it("readPackageDeps extracts declared <dependency> artifactIds", () => {
    expect(readPackageDeps(nodePath.join(root, "consumer"))).toContain("acme-lib");
  });

  it("readPackageDeps returns PRODUCTION deps only (dev/test deps are not architectural coupling)", () => {
    const d = nodePath.join(root, "proddep");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(nodePath.join(d, "package.json"), JSON.stringify({
      name: "proddep",
      dependencies: { "real-dep": "^1.0.0" },
      peerDependencies: { "peer-dep": "*" },
      optionalDependencies: { "opt-dep": "^1.0.0" },
      devDependencies: { "test-dep": "^1.0.0" },
    }));
    const deps = readPackageDeps(d);
    expect(deps).toEqual(expect.arrayContaining(["real-dep", "peer-dep", "opt-dep"]));
    expect(deps).not.toContain("test-dep");
  });

  it("readPackageDeps excludes Cargo [dev-dependencies] and [build-dependencies]", () => {
    const d = nodePath.join(root, "rustdep");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(nodePath.join(d, "Cargo.toml"),
      '[package]\nname = "rustdep"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\ncriterion = "0.5"\n\n[build-dependencies]\ncc = "1"\n');
    const deps = readPackageDeps(d);
    expect(deps).toContain("serde");
    expect(deps).not.toContain("criterion");
    expect(deps).not.toContain("cc");
  });

  it("detectSystem builds the ground-truth repoDeps graph (consumer -> lib)", () => {
    const d = detectSystem(root)!;
    expect(d.repoDeps["consumer"]).toContain("lib");
    // lib declares no intra-system deps.
    expect(d.repoDeps["lib"]).toBeUndefined();
  });
});

describe("git-aware system detection (no flags, monorepo vs separate repos)", () => {
  let base: string;
  const mk = (rel: string) => fs.mkdirSync(nodePath.join(base, rel), { recursive: true });
  const wf = (rel: string, c = "{}") => { const p = nodePath.join(base, rel); fs.mkdirSync(nodePath.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };

  beforeAll(() => {
    base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-gitdet-"));
    // A monorepo: one .git at the root, package dirs with manifests but no own .git.
    mk("mono/.git");
    wf("mono/packages/pkg-a/package.json", '{"name":"pkg-a"}');
    wf("mono/packages/pkg-b/package.json", '{"name":"pkg-b"}');
    // A repo with submodule-style git children directly under it.
    mk("withsubs/.git");
    wf("withsubs/package.json", '{"name":"withsubs"}');
    mk("withsubs/sub-a/.git"); wf("withsubs/sub-a/package.json", '{"name":"sub-a"}');
    mk("withsubs/sub-b/.git"); wf("withsubs/sub-b/package.json", '{"name":"sub-b"}');
    // A plain folder (no .git) collecting two independently-"cloned" git repos.
    mk("collection/repo-a/.git"); wf("collection/repo-a/package.json", '{"name":"repo-a"}');
    mk("collection/repo-b/.git"); wf("collection/repo-b/package.json", '{"name":"repo-b"}');
    // A monorepo with NO .git (downloaded tarball) but a workspaces declaration.
    wf("ws_npm/package.json", '{"name":"root","workspaces":["packages/*"]}');
    wf("ws_npm/packages/a/package.json", '{"name":"a"}');
    wf("ws_npm/packages/b/package.json", '{"name":"b"}');
    // A no-.git monorepo declared via pnpm-workspace.yaml.
    wf("ws_pnpm/pnpm-workspace.yaml", 'packages: ["*"]');
    wf("ws_pnpm/pkg-a/package.json", '{"name":"a"}');
    wf("ws_pnpm/pkg-b/package.json", '{"name":"b"}');
    // A no-.git, no-workspace folder of separate projects (genuinely ambiguous).
    wf("plain/proj-a/package.json", '{"name":"proj-a"}');
    wf("plain/proj-b/package.json", '{"name":"proj-b"}');
  });
  afterAll(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("treats a monorepo (one .git, package dirs) as a SINGLE repo", () => {
    expect(detectSystem(nodePath.join(base, "mono"))).toBeUndefined();
    expect(detectSystem(nodePath.join(base, "mono", "packages"))).toBeUndefined();
  });

  it("treats a repo WITH submodule git children as a single repo (not a system of submodules)", () => {
    expect(detectSystem(nodePath.join(base, "withsubs"))).toBeUndefined();
  });

  it("treats a plain folder of independently-cloned repos as a multi-repo SYSTEM", () => {
    const d = detectSystem(nodePath.join(base, "collection"));
    expect(d).toBeTruthy();
    expect(d!.members.sort()).toEqual(["repo-a", "repo-b"]);
  });

  it("treats a no-.git monorepo (workspaces / pnpm-workspace) as a SINGLE repo", () => {
    // A monorepo extracted without its .git must NOT be split into separate repos.
    expect(detectSystem(nodePath.join(base, "ws_npm"))).toBeUndefined();
    expect(detectSystem(nodePath.join(base, "ws_npm", "packages"))).toBeUndefined();
    expect(detectSystem(nodePath.join(base, "ws_pnpm"))).toBeUndefined();
  });

  it("still treats a no-.git, no-workspace folder of projects as a SYSTEM", () => {
    const d = detectSystem(nodePath.join(base, "plain"));
    expect(d).toBeTruthy();
    expect(d!.members.sort()).toEqual(["proj-a", "proj-b"]);
  });
});

describe("workspace_id convergence (solo vs co-ingest)", () => {
  // The solo path (bootstrap.getOrCreateWorkspace) and the co-ingest member path
  // (repoWorkspaceIdFor) must derive the SAME path-based id for a given repo root,
  // else a repo's nodes diverge between `ix map <repo>` and `ix map <parent>`.
  it("repoWorkspaceIdFor(parent, member) === workspaceIdForPath(parent/member)", () => {
    const memberAbs = nodePath.join(root, "app");
    expect(repoWorkspaceIdFor(root, "app")).toBe(workspaceIdForPath(memberAbs));
  });

  it("is stable and path-distinct (different roots -> different ids)", () => {
    expect(workspaceIdForPath(root)).toBe(workspaceIdForPath(root)); // deterministic
    expect(workspaceIdForPath(nodePath.join(root, "app")))
      .not.toBe(workspaceIdForPath(nodePath.join(root, "lib")));
    expect(workspaceIdForPath(root)).toMatch(/^[0-9a-f]{8}$/); // 8-hex, not a random UUID slice
  });
});

// ── Manifest reads are bounded ───────────────────────────────────────────────
//
// Every path this module reads is named by the *scanned repository*, so a
// hostile or merely broken one decides what `ix map` opens. `readFileSync` on
// `/dev/zero` does not throw — it consumes memory until the process dies — and
// a 2 GB `Cargo.toml` needs no symlink to do the same.
describe("manifest reads are bounded and typed", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-manifest-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still reads an ordinary manifest", () => {
    const ok = nodePath.join(dir, "ok");
    fs.mkdirSync(ok, { recursive: true });
    fs.writeFileSync(nodePath.join(ok, "package.json"), '{ "name": "reads-fine" }');
    expect(readPackageNames(ok)).toContain("reads-fine");
  });

  it("refuses a manifest larger than the cap instead of loading it", () => {
    const big = nodePath.join(dir, "big");
    fs.mkdirSync(big, { recursive: true });
    // Just over 1 MB, and valid JSON, so only the size can be what rejects it.
    const padding = "x".repeat(1024 * 1024);
    fs.writeFileSync(
      nodePath.join(big, "package.json"),
      JSON.stringify({ name: "too-big", description: padding }),
    );
    expect(readPackageNames(big)).toEqual([]);
  });

  it("refuses a manifest that is a directory", () => {
    const weird = nodePath.join(dir, "weird");
    fs.mkdirSync(nodePath.join(weird, "package.json"), { recursive: true });
    expect(() => readPackageNames(weird)).not.toThrow();
    expect(readPackageNames(weird)).toEqual([]);
  });

  // POSIX only: /dev/zero has no Windows equivalent, and creating a symlink
  // there needs privileges the runner does not have.
  it.skipIf(process.platform === "win32")(
    "refuses a manifest symlinked to a character device, rather than reading it forever",
    () => {
      const dev = nodePath.join(dir, "dev");
      fs.mkdirSync(dev, { recursive: true });
      fs.symlinkSync("/dev/zero", nodePath.join(dev, "package.json"));

      // The assertion that matters is that this returns at all: unguarded,
      // the read never does.
      const started = Date.now();
      expect(readPackageNames(dev)).toEqual([]);
      expect(readPackageDeps(dev)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2000);
    },
  );

  it.skipIf(process.platform === "win32")("refuses a manifest that is a FIFO, without blocking on it", () => {
    const fifoDir = nodePath.join(dir, "fifo");
    fs.mkdirSync(fifoDir, { recursive: true });
    const fifo = nodePath.join(fifoDir, "package.json");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // no mkfifo on this runner; the device case already covers the shape
    }
    // Opening a FIFO blocks until a writer appears, which is why the guard
    // stats rather than opens.
    const started = Date.now();
    expect(readPackageNames(fifoDir)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
