// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";

import { resolveEntityFull, scoreCandidate } from "../resolve.js";

// Graph reads refuse a directory no workspace covers (workspace_not_mapped),
// and this suite runs from a checkout that is not registered anywhere. It is
// about resolution, not scoping, so the directory counts as mapped here.
vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));


/**
 * The resolver behind `ix context` / `ix explain` / `ix locate` must pick the
 * code definition of a name, not an import of it (a `module` entity located in
 * the importing file) and not a CSS selector, markdown heading or JSON key
 * that happens to share the name.
 */

const ALL_KINDS = ["file", "class", "object", "trait", "interface", "module", "method", "function", "constant"];

function n(id: string, name: string, kind: string, path: string, attrs: Record<string, unknown> = {}) {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  const language = ({ js: "javascript", ts: "typescript", css: "css", md: "markdown", json: "json" } as Record<string, string>)[ext];
  return { id, name, kind, provenance: { sourceUri: path }, attrs: { language, line_start: 1, line_end: 20, ...attrs } };
}

const imp = (id: string, name: string, path: string) => n(id, name, "module", path, { line_start: 2, line_end: 2 });

/** A fake backend honouring `kind` and `limit`. */
function client(nodes: ReturnType<typeof n>[]) {
  return {
    search: vi.fn(async (_term: string, opts: { limit?: number; kind?: string }) => {
      const matching = opts.kind ? nodes.filter((x) => x.kind === opts.kind) : nodes;
      return matching.slice(0, opts.limit);
    }),
    workspaceSystem: vi.fn(async () => null),
  } as any;
}

async function resolvedId(nodes: ReturnType<typeof n>[], symbol: string): Promise<string | undefined> {
  const result = await resolveEntityFull(client(nodes), symbol, ALL_KINDS, { format: "json" } as any);
  return result.resolved ? result.entity.id : undefined;
}

describe("resolver: definitions over imports", () => {
  it("resolves to the defining file, not the import in another file (tailwind borderStylesReset)", async () => {
    expect(await resolvedId([
      imp("import", "borderStylesReset", "src/lib/generateUtilities.js"),
      n("file", "borderStylesReset.js", "file", "src/generators/borderStylesReset.js"),
    ], "borderStylesReset")).toBe("file");
  });

  it("resolves to a same-named function, not its import", async () => {
    expect(await resolvedId([
      imp("import", "parseConfig", "src/cli.ts"),
      n("fn", "parseConfig", "function", "src/config.ts"),
    ], "parseConfig")).toBe("fn");
  });

  it("resolves a lowercase term to the PascalCase class, not the same-stem file (django paginator)", async () => {
    // No entity is named exactly `paginator`: the case-insensitive fallback
    // finds the class, and the file must not pre-empt that fallback just
    // because its stem matches case-sensitively.
    expect(await resolvedId([
      n("cls", "Paginator", "class", "django/core/paginator.py", { line_end: 200 }),
      n("file", "paginator.py", "file", "django/core/paginator.py", { line_end: 200 }),
    ], "paginator")).toBe("cls");
  });

  it("still prefers a same-named function over a same-stem file", async () => {
    expect(await resolvedId([
      n("file", "debounce.js", "file", "src/debounce.js"),
      n("fn", "debounce", "function", "src/debounce.js"),
    ], "debounce")).toBe("fn");
  });

  it("finds the defining file when imports fill the candidate window", async () => {
    const fake = client([
      ...Array.from({ length: 40 }, (_, i) => imp(`import-${i}`, "borderStylesReset", `src/lib/user${i}.js`)),
      n("file", "borderStylesReset.js", "file", "src/generators/borderStylesReset.js"),
    ]);
    const result = await resolveEntityFull(fake, "borderStylesReset", ALL_KINDS, { format: "json" } as any);
    expect(result.resolved && result.entity.id).toBe("file");
  });

  it("looks further when the window holds only a map region of the name, not a definition", async () => {
    // `ix map` names regions after directories and modules (`Format`, `Search`,
    // `CLI`), with provenance `ix:map`. A region is not a code definition, so
    // it must not stop the lookup for the defining file.
    const fake = client([
      { id: "region", name: "Format", kind: "region", provenance: { sourceUri: "ix:map" }, attrs: {} } as any,
      ...Array.from({ length: 40 }, (_, i) => n(`json-${i}`, "format", "config_entry", `pkg${i}/package.json`)),
      n("file", "format.ts", "file", "src/cli/format.ts"),
    ]);
    const result = await resolveEntityFull(fake, "format", ALL_KINDS, { format: "json" } as any);
    expect(result.resolved && result.entity.id).toBe("file");
  });

  it("does not look further when a definition is in the window", async () => {
    const fake = client([
      n("fn", "parseConfig", "function", "src/config.ts"),
      ...Array.from({ length: 40 }, (_, i) => imp(`import-${i}`, "parseConfig", `src/user${i}.ts`)),
    ]);
    await resolveEntityFull(fake, "parseConfig", ALL_KINDS, { format: "json" } as any);
    expect(fake.search).toHaveBeenCalledTimes(1);
  });
});

describe("resolver: code over non-code", () => {
  it("resolves a function over a CSS selector of the same name", async () => {
    expect(await resolvedId([
      n("css", "flex", "class", "src/css/utilities.css"),
      n("fn", "flex", "function", "src/plugins/flex.js"),
    ], "flex")).toBe("fn");
  });

  it("resolves a class over a markdown heading and a JSON key", async () => {
    expect(await resolvedId([
      n("heading", "Prettier", "heading", "CHANGELOG.md"),
      n("json", "Prettier", "config_entry", "package.json"),
      n("cls", "Prettier", "class", "src/index.js"),
    ], "Prettier")).toBe("cls");
  });

  it("resolves a definition under a committed build/ directory, not its import", async () => {
    expect(await resolvedId([
      imp("import", "generate_metadata", "src/pip/_internal/distributions/sdist.py"),
      n("fn", "generate_metadata", "function", "src/pip/_internal/operations/build/metadata.py"),
    ], "generate_metadata")).toBe("fn");
  });

  it("resolves the source definition over a copy in build output", async () => {
    expect(await resolvedId([
      n("dist", "createServer", "function", "dist/server.js"),
      n("src", "createServer", "function", "src/node/server.ts"),
    ], "createServer")).toBe("src");
  });
});

describe("scoreCandidate", () => {
  it("scores a definition better than an import, and an import better than CSS", () => {
    const fn = scoreCandidate(n("fn", "flex", "function", "src/flex.js"), "flex");
    const im = scoreCandidate(imp("import", "flex", "src/other.js"), "flex");
    const css = scoreCandidate(n("css", "flex", "class", "dist/out.css"), "flex");
    expect(fn).toBeLessThan(im);
    expect(im).toBeLessThan(css);
  });

  it("leaves a multi-line module (a real definition) as a container", () => {
    const mod = scoreCandidate(n("mod", "Billing", "module", "app/billing.rb", { line_start: 1, line_end: 40 }), "Billing");
    const fn = scoreCandidate(n("fn", "Billing", "function", "app/other.rb"), "Billing");
    expect(mod).toBeLessThan(fn);
  });
});

describe("resolver: --path finds a common name past a full window", () => {
  /** A fake backend: weight order is array order; `scope` (if honoured) filters source_uri before `limit`. */
  function scopedClient(nodes: ReturnType<typeof n>[], honoursScope: boolean) {
    return {
      search: vi.fn(async (_term: string, opts: { limit?: number; kind?: string; scope?: string }) => {
        let matching = opts.kind ? nodes.filter((x) => x.kind === opts.kind) : nodes;
        if (honoursScope && opts.scope) {
          const want = opts.scope.toLowerCase();
          matching = matching.filter((x) => x.provenance.sourceUri.toLowerCase().includes(want));
        }
        return matching.slice(0, opts.limit);
      }),
      workspaceSystem: vi.fn(async () => null),
    } as any;
  }

  // 250 other files each declare an `add` that outweighs the one under --path,
  // so the 200-row window is full before it arrives (the CL-20F stale `next`
  // row `ix read add --path core-ingestion/src/role-classifier.ts`).
  const crowd = Array.from({ length: 250 }, (_, i) => n(`other${i}`, "add", "function", `src/m${i}/util.ts`));
  const wanted = n("wanted", "add", "function", "core-ingestion/src/role-classifier.ts");
  const nodes = [...crowd, wanted];

  it("resolves the declaration under --path when the backend applies scope before its limit", async () => {
    const c = scopedClient(nodes, true);
    const result = await resolveEntityFull(c, "add", ALL_KINDS, {
      format: "json", path: "core-ingestion/src/role-classifier.ts",
    } as any);
    expect(result.resolved && result.entity.id).toBe("wanted");
    expect(c.search).toHaveBeenCalledWith("add", expect.objectContaining({ scope: "core-ingestion/src/role-classifier.ts" }));
  });

  it("still misses cleanly on a backend that ignores scope", async () => {
    const result = await resolveEntityFull(scopedClient(nodes, false), "add", ALL_KINDS, {
      format: "json", path: "core-ingestion/src/role-classifier.ts",
    } as any);
    expect(result.resolved).toBe(false);
  });

  it("asks only once when the window is not full", async () => {
    const c = scopedClient([crowd[0], wanted], true);
    const result = await resolveEntityFull(c, "add", ALL_KINDS, {
      format: "json", path: "core-ingestion/src/role-classifier.ts",
    } as any);
    expect(result.resolved && result.entity.id).toBe("wanted");
    expect(c.search).toHaveBeenCalledTimes(1);
  });
});
