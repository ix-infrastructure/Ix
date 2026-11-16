// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Formula/ix.rb is the third delivery path (after the release archives and a
 * source checkout), and nothing builds it in CI: no macOS runner here has brew
 * run the formula. It drifted from the release job unnoticed — `npm install`
 * instead of `npm ci`, a bare `tsc` that wrote the test files into dist/, no
 * dev-dependency prune, no Compass hint (#977). These tests pin the formula to
 * the build the release job does, as text, since Ruby and brew are not
 * available to the unit tests.
 */
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const formula = read("Formula/ix.rb");
const release = read(".github/workflows/release.yml");

/** The body of each Ruby block (`def x` or `x do`) whose opening line matches `head`, closed by the `end` at its indentation. */
function blocks(src: string, head: RegExp): { start: number; body: string }[] {
  const out: { start: number; body: string }[] = [];
  const lines = src.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(.*)$/.exec(lines[i])!;
    if (head.test(m[2])) {
      const close = lines.findIndex((l, j) => j > i && l === `${m[1]}end`);
      expect(close, `block at line ${i + 1} is closed`).toBeGreaterThan(i);
      out.push({ start: offset, body: lines.slice(i + 1, close).join("\n") });
    }
    offset += lines[i].length + 1;
  }
  return out;
}

const install = blocks(formula, /^def install$/)[0]?.body ?? "";
const cdBlocks = (dir: string) => blocks(install, new RegExp(`^cd "${dir}" do$`));

describe("Formula/ix.rb builds what the release builds (#977)", () => {
  it("has an install method and one ix-cli block", () => {
    expect(install).not.toBe("");
    expect(cdBlocks("ix-cli")).toHaveLength(1);
  });

  it("installs from the lockfiles with npm ci, never npm install", () => {
    expect(install).not.toMatch(/"npm",\s*"install"/);
    for (const dir of ["core-ingestion", "ix-cli"]) {
      const first = cdBlocks(dir)[0].body.split("\n").find((l) => /^\s*system /.test(l));
      expect(first?.trim(), `${dir} runs npm ci first`).toBe('system "npm", "ci", "--silent"');
    }
    // The release job does the same, so this is parity rather than taste.
    expect(release).toMatch(/working-directory: core-ingestion\n\s+run: npm ci/);
  });

  it("builds ix-cli with npm run build, not a bare tsc", () => {
    const cli = cdBlocks("ix-cli")[0].body;
    expect(cli).toContain('system "npm", "run", "build"');
    // A bare tsc reads tsconfig.json, which includes the tests, and emits them.
    expect(install).not.toMatch(/"tsc"/);
    // npm run build copies the compose file; the formula no longer needs to.
    expect(install).not.toContain("docker-compose.standalone.yml");
    const build = (JSON.parse(read("ix-cli/package.json")) as { scripts: Record<string, string> }).scripts.build;
    for (const step of ["scripts/build-core-ingestion.mjs", "tsc -p tsconfig.build.json", "docker-compose.standalone.yml"]) {
      expect(build).toContain(step);
    }
  });

  it("prunes dev dependencies from both packages before installing them", () => {
    const cli = cdBlocks("ix-cli")[0].body;
    const build = cli.indexOf('"npm", "run", "build"');
    const prune = cli.indexOf('system "npm", "prune", "--omit=dev"');
    const installCli = cli.indexOf('libexec.install "dist", "node_modules"');
    expect(build).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(build);
    expect(installCli).toBeGreaterThan(prune);

    const ingest = cdBlocks("core-ingestion");
    const pruneBlock = ingest.find((b) => b.body.includes('"npm", "prune", "--omit=dev"'));
    expect(pruneBlock, "core-ingestion is pruned").toBeDefined();
    expect(pruneBlock!.body).toContain("node_modules/tree-sitter-cli");
    expect(pruneBlock!.body).toContain("node_modules/.bin/tree-sitter");
    // The release job prunes and drops tree-sitter-cli the same way.
    expect(release).toContain("(cd core-ingestion && npm prune --omit=dev)");
    expect(release).toContain("rm -rf core-ingestion/node_modules/tree-sitter-cli");
  });

  it("moves core-ingestion into the prefix only after ix-cli has built and it has been pruned", () => {
    // Pathname#install moves files. Moving core-ingestion/dist before ix-cli's
    // build leaves that build without it (the #1073 review).
    const move = install.indexOf('(prefix/"core-ingestion").install');
    const cli = cdBlocks("ix-cli")[0];
    const pruneBlock = cdBlocks("core-ingestion").find((b) => b.body.includes('"prune"'))!;
    expect(move).toBeGreaterThan(cli.start + cli.body.length);
    expect(move).toBeGreaterThan(pruneBlock.start + pruneBlock.body.length);
    expect(install.match(/\(prefix\/"core-ingestion"\)\.install/g)).toHaveLength(1);
  });

  it("tells the user how to get Compass for ix view", () => {
    const caveats = blocks(formula, /^def caveats$/)[0]?.body ?? "";
    expect(caveats).toContain("ix view");
    expect(caveats).toContain("ix upgrade");
  });

  it("tests more than --version: core-ingestion parses and dist/ has no tests", () => {
    const test = blocks(formula, /^test do$/)[0]?.body ?? "";
    expect(test).toContain("--version");
    expect(test).toContain("parseFile");
    expect(test).toContain("__tests__");
  });

  it("keeps a single url and sha256 line for the release job's sed to rewrite", () => {
    // release.yml rewrites every `url "..."` and `sha256 "..."` (and
    // `# sha256 ...`) line in the formula. A second one would be clobbered.
    expect(release).toContain(`sed -i "s|url \\".*\\"|url \\"\${TARBALL_URL}\\"|" Formula/ix.rb`);
    expect(formula.split("\n").filter((l) => /url ".*"/.test(l))).toHaveLength(1);
    expect(formula.split("\n").filter((l) => /sha256 ".*"|# sha256 /.test(l))).toHaveLength(1);
  });
});
