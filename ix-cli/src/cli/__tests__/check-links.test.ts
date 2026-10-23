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
