// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The contributor-facing documents drift from the repo silently: CONTRIBUTING
 * listed one test command while CI gated on a dozen, CLAUDE.md pointed at a
 * script path that does not exist, and the PR template asked for a version
 * bump the release process does not use (#988). These tests pin each of those
 * claims to the file that is the source of truth.
 */
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

interface CiStep {
  run?: string;
  "working-directory"?: string;
}
interface CiJob {
  defaults?: { run?: { "working-directory"?: string } };
  steps?: CiStep[];
}

/** `<dir>\0<command>` for every single-line `run:` step in ci.yml. */
function ciCommands(): Set<string> {
  const wf = parse(read(".github/workflows/ci.yml")) as { jobs: Record<string, CiJob> };
  const out = new Set<string>();
  for (const job of Object.values(wf.jobs)) {
    const jobDir = job.defaults?.run?.["working-directory"] ?? ".";
    for (const step of job.steps ?? []) {
      // Multi-line blocks (the NUL guard, actionlint, the install smokes, the
      // write→read smoke) are CI-environment scripts, described in prose.
      if (!step.run || step.run.trim().includes("\n")) continue;
      out.add(`${posix.normalize(step["working-directory"] ?? jobDir)}\0${step.run.trim()}`);
    }
  }
  return out;
}

/** The "Before you open a PR" section of CONTRIBUTING.md. */
function beforePrSection(): string {
  const doc = read("CONTRIBUTING.md");
  const start = doc.indexOf("\n## Before you open a PR\n");
  expect(start, "CONTRIBUTING.md has a '## Before you open a PR' section").toBeGreaterThan(-1);
  const end = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

/**
 * Replays the bash fences of a markdown section as a shell would: tracks
 * `cd`, splits `&&`, drops comments and leading `VAR=value` assignments, and
 * returns `<dir>\0<command>` for every command it would run.
 */
function documentedCommands(section: string): Set<string> {
  const out = new Set<string>();
  for (const fence of section.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
    let cwd = ".";
    for (const raw of fence[1].split("\n")) {
      const line = raw
        .replace(/\s+#.*$/, "")
        .replace(/^#.*$/, "")
        .trim();
      if (!line) continue;
      for (const part of line.split("&&").map((p) => p.trim())) {
        const cd = /^cd\s+(\S+)$/.exec(part);
        if (cd) {
          cwd = posix.normalize(posix.join(cwd, cd[1]));
          continue;
        }
        out.add(`${cwd}\0${part.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "")}`);
      }
    }
  }
  return out;
}

// CI commands a contributor does not run by hand, each with the reason.
const NOT_FOR_CONTRIBUTORS: Record<string, string> = {
  "ix-cli\0npm ci --silent": "install step; the setup commands cover it",
  "ix-cli\0npm run test:coverage": "the test:unit suite with coverage, on one matrix leg",
  ".\0docker compose -f docker-compose.standalone.yml up -d --wait --wait-timeout 180":
    "the smoke backend; Local Setup starts the same stack with ./scripts/backend.sh up",
  'ix-cli\0node scripts/perf-gate.mjs "$GITHUB_WORKSPACE/perf-fixture" --out "$RUNNER_TEMP/perf-results.json"':
    "needs CI's pinned fixture checkout",
};

// CI runs the step a package script wraps, after building dist/ in an earlier
// step; the document gives the script. Checked against package.json below.
const SAME_AS: Record<string, string> = {
  "ix-cli\0npx vitest run --config vitest.e2e.config.ts": "ix-cli\0npm run test:e2e",
};

describe("CONTRIBUTING lists what CI gates on (#988)", () => {
  it("every single-line CI command appears in 'Before you open a PR', in the same directory", () => {
    const documented = documentedCommands(beforePrSection());
    const missing = [...ciCommands()]
      .filter((c) => !(c in NOT_FOR_CONTRIBUTORS))
      .filter((c) => !documented.has(SAME_AS[c] ?? c))
      .map((c) => c.replace("\0", ": "));
    expect(missing).toEqual([]);
  });

  it("the exemptions above still name real CI commands", () => {
    const ci = ciCommands();
    const stale = [...Object.keys(NOT_FOR_CONTRIBUTORS), ...Object.keys(SAME_AS)].filter(
      (c) => !ci.has(c),
    );
    expect(stale.map((c) => c.replace("\0", ": "))).toEqual([]);
  });

  it("npm run test:e2e is the build plus the command CI runs", () => {
    const pkg = JSON.parse(read("ix-cli/package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:e2e"]).toBe(
      "npm run build && vitest run --config vitest.e2e.config.ts",
    );
  });

  it("links the e2e harness README", () => {
    expect(beforePrSection()).toContain("(ix-cli/test/e2e/README.md)");
    expect(existsSync(join(ROOT, "ix-cli/test/e2e/README.md"))).toBe(true);
  });

  it("does not claim Trivy scans a Docker image no workflow scans", () => {
    const doc = read("CONTRIBUTING.md");
    const trivy = doc.split("\n").find((l) => l.includes("**Trivy"));
    expect(trivy).toBeDefined();
    expect(trivy).not.toMatch(/docker image/i);
    for (const wf of [".github/workflows/security.yml", ".github/workflows/config-security.yml"]) {
      expect(read(wf)).not.toMatch(/scan-type:\s*image/);
    }
  });
});

describe("contributor documents match the repo (#988)", () => {
  it("CLAUDE.md names the bootstrap script where it lives", () => {
    expect(existsSync(join(ROOT, "scripts/bootstrap.sh"))).toBe(false);
    expect(existsSync(join(ROOT, "skills/ix/scripts/bootstrap.sh"))).toBe(true);
    const claude = read("CLAUDE.md");
    expect(claude).not.toMatch(/(?<![\w/])scripts\/bootstrap\.sh/);
    expect(claude).not.toMatch(/\| `scripts\/` \|[^\n]*bootstrap/);
    expect(claude).toContain("skills/ix/scripts/bootstrap.sh");
  });

  it("the PR template does not ask for a package.json version bump", () => {
    // release.yml stamps the version from the tag (`npm version "$VERSION"`).
    expect(read(".github/workflows/release.yml")).toContain(
      'npm version "$VERSION" --no-git-tag-version',
    );
    const template = read(".github/PULL_REQUEST_TEMPLATE.md");
    expect(template).not.toMatch(/version bumped/i);
    expect(template).toContain("stamps the version from the tag");
  });

  it("the e2e README refers to the backend pin without its version", () => {
    const compose = read("ix-cli/test/e2e/compose.e2e.yml");
    const tag = /ix-memory-layer:(\d+\.\d+\.\d+)@sha256/.exec(compose)?.[1];
    expect(tag).toBeDefined();
    const readme = read("ix-cli/test/e2e/README.md");
    expect(readme).toContain("the pin in `compose.e2e.yml`");
    expect(readme).not.toMatch(/ix-memory-layer[: ]v?\d+\.\d+\.\d+/);
    expect(readme).not.toContain(tag!);
  });

  it("SECURITY.md gives the backend's reporting address", () => {
    const security = read("SECURITY.md");
    const scope = security.slice(security.indexOf("## Scope"));
    expect(scope).not.toMatch(/has its own reporting channel\.?\s*$/m);
    expect(scope).toMatch(/security@ix-infra\.com/);
  });
});

describe("the architecture document (#987)", () => {
  const ARCH = "docs/architecture.md";

  it("exists and is linked from CONTRIBUTING, the docs index and the site's contributing page", () => {
    expect(existsSync(join(ROOT, ARCH)), `${ARCH} exists`).toBe(true);
    expect(read("CONTRIBUTING.md")).toContain("(docs/architecture.md)");
    expect(read("docs/README.md")).toContain("(architecture.md)");
    // The site page names the path rather than linking it: CI probes an
    // absolute GitHub URL, which 404s until the file is on main.
    expect(read("docs-site/src/content/docs/community/contributing.md")).toContain(
      "`docs/architecture.md`",
    );
  });

  it("every repo path it names exists", () => {
    // Backticked tokens rooted at a top-level directory. Placeholders
    // (`commands/<name>.ts`) and globs are illustrations, not paths.
    const roots = /^(?:ix-cli|core-ingestion|docs|docs-site|scripts|skills|Formula|\.github)\//;
    const named = [...read(ARCH).matchAll(/`([^`\s]+)`/g)]
      .map((m) => m[1].replace(/\(\)$/, ""))
      .filter((t) => roots.test(t) && !/[<>*]/.test(t));
    expect(named.length).toBeGreaterThan(20);
    const missing = [...new Set(named)].filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it("names every CI job in its tests-and-CI section", () => {
    const doc = read(ARCH);
    const start = doc.indexOf("\n## Tests and CI\n");
    expect(start, `${ARCH} has a '## Tests and CI' section`).toBeGreaterThan(-1);
    const end = doc.indexOf("\n## ", start + 1);
    const section = doc.slice(start, end === -1 ? undefined : end);
    const wf = parse(read(".github/workflows/ci.yml")) as { jobs: Record<string, CiJob> };
    const unnamed = Object.keys(wf.jobs).filter((job) => !section.includes(`\`${job}\``));
    expect(unnamed).toEqual([]);
  });

  it("states the rules that otherwise live only in comments, next to what enforces them", () => {
    const doc = read(ARCH);
    // Every client from the factory, held by an ESLint rule.
    expect(doc).toContain("createClient()");
    expect(read("ix-cli/eslint.config.js")).toContain("NewExpression[callee.name='IxClient']");
    // A command is one manifest entry; the Pro surface is one table.
    expect(doc).toContain("OSS_COMMANDS");
    expect(doc).toContain("PRO_COMMANDS");
    // Runtime files ship through three packaging paths.
    for (const path of ["ix-cli/package.json", ".github/workflows/release.yml", "Formula/ix.rb"]) {
      expect(doc).toContain(`\`${path}\``);
    }
    // The patch schema is one file copied byte for byte.
    expect(read("ix-cli/src/client/graph-schema.ts")).toBe(read("core-ingestion/src/schema.ts"));
    expect(doc).toContain("`core-ingestion/src/schema.ts`");
    expect(doc).toContain("`ix-cli/src/client/graph-schema.ts`");
  });
});
