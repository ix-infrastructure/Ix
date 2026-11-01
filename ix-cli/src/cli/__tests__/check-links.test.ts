// Copyright 2026 Ix Infrastructure Inc.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The dead-link gate (ix-cli/scripts/check-links.mjs) is a plain script that
 * CI runs from the repo root with no build step and no exports. These tests
 * run it the same way, against a throwaway git repo, with `--offline` so no
 * external URL is ever probed: only relative links, docs-site routes and
 * anchors are exercised, which is the logic worth pinning.
 */
const SCRIPT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "scripts", "check-links.mjs");

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(files: Record<string, string>, args: string[] = ["--offline"]) {
  const root = mkdtempSync(join(tmpdir(), "check-links-"));
  scratch.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  // The gate reads `git ls-files`, so the fixture has to be a repo with the
  // files staged.
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["add", "-A"], { cwd: root });
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
  const errors = res.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("ERROR  "))
    .map((l) => l.slice("ERROR  ".length));
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, errors };
}

const HEADINGS = [
  "# Title",
  "",
  "## `ix callers <symbol>`",
  "## `IX_HOME`",
  "## max_tokens",
  "## See [Foo](bar.md)",
  "## Setup",
  "## Setup",
  "## _emph_ and **bold** and __init__",
  "## Café déjà vu",
  "## C++ & Rust: a <b>tag</b> heading",
  "",
  '<a id="custom"></a>',
  "",
  "````md",
  "```",
  "## Not a heading",
  "```",
  "[broken in a fence](nope.md)",
  "````",
  "",
  "Inline code is not a link: `[x](nowhere.md)`.",
  "",
].join("\n");

describe("check-links heading slugs", () => {
  it("accepts the slugs GitHub and Starlight render, and only those", () => {
    const { status, errors } = run({
      "docs/bar.md": "",
      "docs/a.md": HEADINGS,
      "docs/b.md": [
        "[1](a.md#ix-callers-symbol) [2](a.md#ix_home) [3](a.md#max_tokens) [4](a.md#see-foo)",
        "[5](a.md#setup) [6](a.md#setup-1) [7](a.md#emph-and-bold-and-init) [8](a.md#café-déjà-vu)",
        "[9](a.md#custom) [10](a.md#c--rust-a-tag-heading) [11](a.md#title)",
        "",
      ].join("\n"),
    });
    expect(errors).toEqual([]);
    expect(status).toBe(0);
  });

  it("reports the near-miss forms the old slug rule produced", () => {
    const { status, errors } = run({
      "docs/bar.md": "",
      "docs/a.md": HEADINGS,
      "docs/b.md": [
        "[b1](a.md#ix-callers) [b2](a.md#ixhome) [b3](a.md#maxtokens) [b4](a.md#see-foobarmd)",
        "[b5](a.md#setup-2) [b6](a.md#not-a-heading)",
        "",
      ].join("\n"),
    });
    expect(errors).toEqual([
      "a.md#ix-callers (anchor, in docs/b.md)",
      "a.md#ixhome (anchor, in docs/b.md)",
      "a.md#maxtokens (anchor, in docs/b.md)",
      "a.md#see-foobarmd (anchor, in docs/b.md)",
      "a.md#setup-2 (anchor, in docs/b.md)",
      "a.md#not-a-heading (anchor, in docs/b.md)",
    ]);
    expect(status).toBe(1);
  });
});

describe("check-links link extraction", () => {
  it("skips links in fences and inline code, and strips a link title", () => {
    const { status, errors } = run({
      "docs/a.md": HEADINGS,
      "docs/bar.md": "",
      "docs/c.md": '[ok](a.md "A title") [ok2](<a.md>) [bad](missing.md "Title")\n',
    });
    expect(errors).toEqual(["missing.md (relative, in docs/c.md)"]);
    expect(status).toBe(1);
  });
});

describe("check-links docs-site surface", () => {
  const site = (index: string) => ({
    "docs-site/src/content/docs/index.mdx": `---\ntitle: Home\n---\n\n${index}\n`,
    "docs-site/src/content/docs/guide.md":
      '## Install\n\n<a href="/guide/">raw HTML in .md is rewritten by base-links-plugin</a>\n',
  });

  it("accepts page-relative tag hrefs, #_top and generated endpoint routes", () => {
    const { status, errors } = run(
      site(
        [
          '<LinkCard title="Guide" href="guide/" />',
          "[top](#_top) [guide top](/guide/#_top) [install](/guide/#install)",
          "[endpoint](/api/endpoints/anything/)",
        ].join("\n"),
      ),
    );
    expect(errors).toEqual([]);
    expect(status).toBe(0);
  });

  it("rejects a root-relative href on an MDX tag, a missing route and a missing anchor", () => {
    const { status, errors } = run(
      site(
        [
          '<LinkCard title="Guide" href="/guide/" />',
          '<a href="/guide/">raw a</a>',
          "[bad anchor](/guide/#nope) [bad route](/nowhere/)",
        ].join("\n"),
      ),
    );
    const file = "docs-site/src/content/docs/index.mdx";
    expect(errors).toEqual([
      `/guide/#nope (anchor, in ${file})`,
      `/nowhere/ (docs-site route, in ${file})`,
      expect.stringContaining(`/guide/ (root-relative href in a tag, in ${file})`),
      expect.stringContaining(`/guide/ (root-relative href in a tag, in ${file})`),
    ]);
    expect(status).toBe(1);
  });

  it("reports #_top as missing outside the docs site", () => {
    const { errors } = run({ "docs/a.md": "# A\n\n[top](#_top)\n" });
    expect(errors).toEqual(["#_top (anchor, in docs/a.md)"]);
  });
});

describe("check-links arguments", () => {
  it("refuses an unknown argument before doing any work", () => {
    const { status, stderr, stdout } = run({ "docs/a.md": "[x](https://example.invalid/)\n" }, ["--nope"]);
    expect(status).toBe(2);
    expect(stderr).toContain("unknown argument: --nope");
    expect(stdout).toBe("");
  });
});

/**
 * The built-dist pass (`--dist <dir> --dist-only`) crawls what the docs build
 * actually emits. These tests build a miniature dist by hand — the root
 * `_redirects` and `404.html` that finalize-dist.mjs writes, plus two pages
 * under /oss/ — so the crawl's resolution rules are pinned without a build.
 */
describe("check-links built dist crawl", () => {
  const DIST_FILES: Record<string, string> = {
    "_redirects": "/  /oss/  302\n",
    "404.html": "<!doctype html><title>404</title>\n",
    "oss/index.html":
      '<a href="/oss/guide/">guide</a>\n<a href="/oss/guide/#install">install</a>\n<a href="/">root</a>\n',
    "oss/guide/index.html": '<h2 id="install">Install</h2>\n',
  };

  function runDist(files: Record<string, string>, args: string[]) {
    const root = mkdtempSync(join(tmpdir(), "check-links-dist-"));
    scratch.push(root);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, "dist", rel)), { recursive: true });
      writeFileSync(join(root, "dist", rel), body);
    }
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
    const errors = res.stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith("ERROR  "))
      .map((l) => l.slice("ERROR  ".length));
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, errors };
  }

  it("passes when every built href and fragment resolves inside dist/", () => {
    const { status, stdout, errors } = runDist(DIST_FILES, ["--dist", "dist", "--dist-only"]);
    expect(errors).toEqual([]);
    // Three hrefs: a page, a page#fragment and a _redirects source.
    expect(stdout).toContain("checked 3 references — 0 broken, 0 warnings");
    expect(status).toBe(0);
  });

  it("fails naming the file and line when a built route does not exist", () => {
    const { status, errors } = runDist(
      { ...DIST_FILES, "oss/index.html": '<a href="/oss/missing/">gone</a>\n' },
      ["--dist", "dist", "--dist-only"],
    );
    expect(errors).toEqual(["/oss/missing/ (dist href, in oss/index.html#L1)"]);
    expect(status).toBe(1);
  });

  it("fails on a fragment the built page does not expose", () => {
    const { status, errors } = runDist(
      { ...DIST_FILES, "oss/index.html": '<a href="/oss/guide/#nope">bad</a>\n' },
      ["--dist", "dist", "--dist-only"],
    );
    expect(errors).toEqual(["/oss/guide/#nope (dist anchor, in oss/index.html#L1)"]);
    expect(status).toBe(1);
  });

  it("rejects a root-relative href the base plugin failed to rewrite", () => {
    const { status, errors } = runDist(
      { ...DIST_FILES, "oss/index.html": '<a href="/guide/">no base</a>\n' },
      ["--dist", "dist", "--dist-only"],
    );
    expect(errors).toEqual(["/guide/ (dist href, in oss/index.html#L1)"]);
    expect(status).toBe(1);
  });

  it("requires --dist for --dist-only, and a value for --dist", () => {
    const noDist = runDist(DIST_FILES, ["--dist-only"]);
    expect(noDist.status).toBe(2);
    expect(noDist.stderr).toContain("--dist-only needs --dist");
    const dangling = runDist(DIST_FILES, ["--dist"]);
    expect(dangling.status).toBe(2);
    expect(dangling.stderr).toContain("--dist needs a built-dist directory");
  });

  // A walk that finds no page has checked nothing, and must not report clean.
  // Before this guard an empty build printed `checked 0 references — 0 broken`
  // and exited 0, so "the build emitted nothing" looked exactly like "the build
  // is clean". The fixture keeps a `_redirects` and an asset, so it is a real
  // tree with content — just no HTML to crawl.
  it("fails when the built tree holds no HTML pages", () => {
    const { status, stdout, errors } = runDist(
      { "_redirects": "/  /oss/  302\n", "oss/_astro/app.css": "body{}\n" },
      ["--dist", "dist", "--dist-only"],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("dist crawl failed");
    expect(errors[0]).toContain("no .html files found");
    expect(errors[0]).toContain("the walk was empty");
    expect(stdout).toContain("checked 0 references — 1 broken, 0 warnings");
    expect(status).toBe(1);
  });

  // --dist-only exists so the docs-site CI job reports on what ships. A tracked
  // source link the repo's own `links` job already fails must not fail the build
  // step too, so the scoped run has to ignore the tracked tree entirely. The
  // second half of the test proves the fixture would fail without the flag, so
  // the first half cannot pass vacuously.
  it("scopes --dist-only to the build, so a dead tracked source link cannot fail it", () => {
    const files = {
      "docs/a.md": "[dead](nowhere.md)\n",
      "dist/oss/index.html": '<a href="/oss/">fine</a>\n',
    };
    const scoped = run(files, ["--dist", "dist", "--dist-only", "--offline"]);
    expect(scoped.errors).toEqual([]);
    expect(scoped.stdout).toContain("checked 1 references — 0 broken, 0 warnings");
    expect(scoped.status).toBe(0);

    const unscoped = run(files);
    expect(unscoped.errors).toEqual(["nowhere.md (relative, in docs/a.md)"]);
    expect(unscoped.status).toBe(1);
  });
});
