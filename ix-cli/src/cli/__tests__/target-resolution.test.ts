// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { printJson, resetResolutionNotices } from "../format.js";
import { resolveFileOrEntityFull, resolveFileOrReport } from "../resolve.js";

// Same stand-in as resolver-definitions-first: the checkout is not a registered
// workspace, and this suite is about resolution, not scoping.
vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

/**
 * CL-19B: a target that matches several things no longer picks one silently.
 * It still resolves where it resolved before (exit 0) and reports what it
 * passed over; what was ambiguous (exit 2 now) stays so. No new non-zero exit.
 */

type Node = ReturnType<typeof node>;

function node(id: string, name: string, kind: string, path: string, line = 1) {
  return { id, name, kind, provenance: { sourceUri: path }, attrs: { line_start: line, line_end: line + 10 } };
}

const file = (path: string, id = path) => node(id, path.slice(path.lastIndexOf("/") + 1), "file", path);

/** A fake backend: name substring match, `kind` and `limit` honoured. */
function client(nodes: Node[]) {
  return {
    search: vi.fn(async (term: string, opts: { limit?: number; kind?: string }) => {
      const t = term.toLowerCase();
      const hits = nodes.filter((x) => (!opts.kind || x.kind === opts.kind) && x.name.toLowerCase().includes(t));
      return hits.slice(0, opts.limit);
    }),
    workspaceSystem: vi.fn(async () => null),
  } as any;
}

/** Run `fn` against the backend in both of its orders. */
async function inBothOrders<T>(nodes: Node[], fn: (c: any) => Promise<T>): Promise<[T, T]> {
  return [await fn(client(nodes)), await fn(client([...nodes].reverse()))];
}

let logs: string[];
let errs: string[];

beforeEach(() => {
  process.exitCode = undefined;
  resetResolutionNotices();
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { errs.push(String(chunk)); return true; }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  resetResolutionNotices();
});

async function full(c: any, target: string, opts: Record<string, unknown> = {}) {
  return resolveFileOrEntityFull(c, target, { format: "json", ...opts } as any);
}

function paths(notices: any[] | undefined): string[] {
  return (notices?.[0]?.candidates ?? []).map((c: any) => c.path);
}

const PACKAGES = [
  file("packages/ab/src/index.ts"),
  file("packages/beta/src/index.ts"),
  file("packages/gamma/src/index.ts"),
];

describe("acceptance 1: a bare basename shared by three files", () => {
  it("resolves to the same file in both orders, scored, with a notice in rank order", async () => {
    const [a, b] = await inBothOrders(PACKAGES, (c) => full(c, "index.ts"));
    for (const r of [a, b]) {
      expect(r.resolved).toBe(true);
      if (!r.resolved) continue;
      expect(r.entity.resolutionMode).toBe("scored");
      expect(r.notices?.[0].code).toBe("ambiguous_target");
      expect(r.notices?.[0].total).toBe(3);
      expect(paths(r.notices)).toEqual(PACKAGES.map((p) => p.provenance.sourceUri));
    }
    expect(a.resolved && b.resolved && a.entity.id === b.entity.id).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("--pick 2 selects packages/beta", async () => {
    const [a, b] = await inBothOrders(PACKAGES, (c) => full(c, "index.ts", { pick: 2 }));
    for (const r of [a, b]) {
      expect(r.resolved && r.entity.path).toBe("packages/beta/src/index.ts");
    }
  });
});

describe("acceptance 2: a suffix shared by three packages", () => {
  it("resolves, never as exact, with a notice", async () => {
    const [a, b] = await inBothOrders(PACKAGES, (c) => full(c, "src/index.ts"));
    for (const r of [a, b]) {
      expect(r.resolved).toBe(true);
      if (!r.resolved) continue;
      expect(r.entity.resolutionMode).not.toBe("exact");
      expect(r.notices?.[0].total).toBe(3);
    }
    expect(a.resolved && b.resolved && a.entity.id === b.entity.id).toBe(true);
  });

  it("a root src/index.ts wins at the full-path tier: exact, no notice", async () => {
    const nodes = [file("src/index.ts"), ...PACKAGES];
    const [a, b] = await inBothOrders(nodes, (c) => full(c, "src/index.ts"));
    for (const r of [a, b]) {
      expect(r.resolved && r.entity.path).toBe("src/index.ts");
      expect(r.resolved && r.entity.resolutionMode).toBe("exact");
      expect(r.resolved && r.notices).toBeUndefined();
    }
  });

  it("an absolute path picks the deeper file", async () => {
    const nodes = [file("src/index.ts"), ...PACKAGES];
    const [a, b] = await inBothOrders(nodes, (c) => full(c, "/work/repo/packages/beta/src/index.ts"));
    for (const r of [a, b]) {
      expect(r.resolved && r.entity.path).toBe("packages/beta/src/index.ts");
      expect(r.resolved && r.notices).toBeUndefined();
    }
  });
});

describe("acceptance 3: a suffix stops at a path segment", () => {
  const nodes = [file("ix-cli/config.ts"), file("src/cli/config.ts")];

  it("cli/config.ts is src/cli/config.ts, not ix-cli/config.ts, and says nothing", async () => {
    const [a, b] = await inBothOrders(nodes, (c) => full(c, "cli/config.ts"));
    for (const r of [a, b]) {
      expect(r.resolved && r.entity.path).toBe("src/cli/config.ts");
      expect(r.resolved && r.notices).toBeUndefined();
    }
  });

  it("li/config.ts (not on a boundary) still resolves, so no new exit 1", async () => {
    const [a, b] = await inBothOrders(nodes, (c) => full(c, "li/config.ts"));
    expect(a.resolved).toBe(true);
    expect(b.resolved).toBe(true);
    expect(a.resolved && b.resolved && a.entity.id === b.entity.id).toBe(true);
  });
});

describe("a suffix not on a '/' boundary is labelled fuzzy (review round 5)", () => {
  const nodes = [file("docs-site/package.json"), file("package.json")];

  it("site/package.json resolves to docs-site/package.json as fuzzy, with a fuzzy_match notice, exit 0", async () => {
    const [a, b] = await inBothOrders(nodes, (c) => full(c, "site/package.json"));
    for (const r of [a, b]) {
      expect(r.resolved && r.entity.path).toBe("docs-site/package.json");
      expect(r.resolved && r.entity.resolutionMode).toBe("fuzzy");
      expect(r.resolved && r.notices?.map((n) => n.code)).toEqual(["fuzzy_match"]);
    }
    expect(process.exitCode).toBeUndefined();
  });

  it("a suffix on a boundary stays scored with no notice", async () => {
    const deeper = [file("apps/docs-site/package.json"), file("package.json")];
    const [a, b] = await inBothOrders(deeper, (c) => full(c, "docs-site/package.json"));
    for (const r of [a, b]) {
      expect(r.resolved && r.entity.path).toBe("apps/docs-site/package.json");
      expect(r.resolved && r.entity.resolutionMode).toBe("scored");
      expect(r.resolved && r.notices).toBeUndefined();
    }
  });

  it("a longer path ending in the uri on a boundary is not fuzzy", async () => {
    const r = await full(client(nodes), "repo/docs-site/package.json");
    expect(r.resolved && r.entity.path).toBe("docs-site/package.json");
    expect(r.resolved && r.entity.resolutionMode).not.toBe("fuzzy");
    expect(r.resolved && r.notices).toBeUndefined();
  });

  it("a non-boundary tie keeps the ambiguous_target notice and adds fuzzy_match", async () => {
    const tie = [file("a-site/package.json"), file("b-site/package.json")];
    const [a, b] = await inBothOrders(tie, (c) => full(c, "site/package.json"));
    for (const r of [a, b]) {
      expect(r.resolved && r.entity.path).toBe("a-site/package.json");
      expect(r.resolved && r.entity.resolutionMode).toBe("fuzzy");
      expect(r.resolved && r.notices?.map((n) => n.code)).toEqual(["ambiguous_target", "fuzzy_match"]);
    }
  });
});

describe("acceptance 4: two functions named render stay ambiguous (exit 2)", () => {
  const nodes = [node("r2", "render", "function", "src/z.ts", 5), node("r1", "render", "function", "src/a.ts", 9)];

  it("json: path-sorted candidates with total, the same in both orders", async () => {
    const outs: any[] = [];
    for (const c of [client(nodes), client([...nodes].reverse())]) {
      logs.length = 0;
      process.exitCode = undefined;
      expect(await resolveFileOrReport(c, "render", {}, "json")).toBeNull();
      expect(process.exitCode).toBe(2);
      outs.push(JSON.parse(logs[0]));
    }
    expect(outs[0].error).toBe("ambiguous_target");
    expect(outs[0].total).toBe(2);
    expect(outs[0].candidates.map((c: any) => c.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(outs[0].candidates).toEqual(outs[1].candidates);
  });

  it("llm: count= unchanged, shown= and total= added", async () => {
    await resolveFileOrReport(client(nodes), "render", {}, "llm");
    expect(process.exitCode).toBe(2);
    expect(logs[0]).toMatch(/^error code=ambiguous_target .*count=2 shown=2 total=2/);
  });
});

describe("acceptance 5: Class.method, Class#method and Class::method", () => {
  const nodes = [
    node("cls", "IxClient", "class", "src/client/api.ts", 10),
    node("m-api", "expand", "method", "src/client/api.ts", 200),
    node("m-other", "expand", "method", "src/other/graph.ts", 30),
    node("os", "os.path", "module", "lib/os.py"),
  ];

  for (const sep of [".", "#", "::"]) {
    it(`IxClient${sep}expand is the method in src/client/api.ts`, async () => {
      const [a, b] = await inBothOrders(nodes, (c) => full(c, `IxClient${sep}expand`));
      for (const r of [a, b]) {
        expect(r.resolved && r.entity.id).toBe("m-api");
        expect(r.resolved && r.entity.name).toBe(`IxClient${sep}expand`);
      }
      expect(process.exitCode).toBeUndefined();
    });
  }

  it("a name stored with a dot still resolves literally", async () => {
    const r = await full(client(nodes), "os.path");
    expect(r.resolved && r.entity.id).toBe("os");
  });

  for (const sep of [".", "#", "::"]) {
    it(`Worker${sep}run with two tied methods is ambiguous, not a miss`, async () => {
      const tied = [
        node("w", "Worker", "class", "src/worker.ts", 1),
        node("r1", "run", "method", "src/worker.ts", 10),
        node("r2", "run", "method", "src/worker.ts", 20),
      ];
      const r = await full(client(tied), `Worker${sep}run`);
      expect(r.resolved).toBe(false);
      expect(r.resolved === false && "ambiguous" in r && r.ambiguous).toBe(true);
    });
  }

  it("--pick on a fuzzy match keeps the fuzzy notice on the picked entity", async () => {
    const fz = [
      node("a", "WorkerAlpha", "class", "src/a.ts"),
      node("b", "WorkerBeta", "interface", "src/b.ts"),
    ];
    const r = await full(client(fz), "Worker", { pick: 2 });
    if (!r.resolved) throw new Error("expected resolved");
    expect(r.entity.id).toBe("b");
    for (const n of r.notices ?? []) expect(n.chosen.id).toBe("b");
  });

  for (const sep of [".", "#"]) {
    it(`Config${sep}load with Config in two files is ambiguous between the methods, not a miss`, async () => {
      const twoClasses = [
        node("ca", "Config", "class", "a/config.ts", 1),
        node("cb", "Config", "class", "b/config.ts", 1),
        node("la", "load", "method", "a/config.ts", 10),
        node("lb", "load", "method", "b/config.ts", 10),
      ];
      const [a, b] = await inBothOrders(twoClasses, (c) => full(c, `Config${sep}load`));
      for (const r of [a, b]) {
        if (r.resolved || !r.ambiguous) throw new Error("expected ambiguous");
        expect(r.result.candidates.map((c) => c.id)).toEqual(["la", "lb"]);
        expect(r.result.total).toBe(2);
      }
      const picked = await full(client(twoClasses), `Config${sep}load`, { pick: 2 });
      expect(picked.resolved && picked.entity.id).toBe("lb");
      expect(picked.resolved && picked.entity.name).toBe(`Config${sep}load`);
    });

    it(`Config${sep}load resolves when only one of the Config classes has it`, async () => {
      const oneHas = [
        node("ca", "Config", "class", "a/config.ts", 1),
        node("cb", "Config", "class", "b/config.ts", 1),
        node("lb", "load", "method", "b/config.ts", 10),
      ];
      const [a, b] = await inBothOrders(oneHas, (c) => full(c, `Config${sep}load`));
      for (const r of [a, b]) {
        expect(r.resolved && r.entity.id).toBe("lb");
        expect(r.resolved && r.entity.name).toBe(`Config${sep}load`);
      }
    });
  }

  for (const sep of [".", "#"]) {
    it(`User${sep}save stays a miss when only UserService exists (no fuzzy class)`, async () => {
      const nodes2 = [
        node("us", "UserService", "class", "app/user_service.py", 1),
        node("save", "save", "method", "app/user_service.py", 10),
      ];
      const [a, b] = await inBothOrders(nodes2, (c) => full(c, `User${sep}save`));
      for (const r of [a, b]) expect(r.resolved || ("ambiguous" in r && r.ambiguous)).toBe(false);
    });

    it(`Config${sep}load ignores a fuzzy near-name method (loader)`, async () => {
      const onlyNear = [
        node("ca", "Config", "class", "a/config.py", 1),
        node("cb", "Config", "class", "b/config.py", 1),
        node("ldr", "loader", "method", "a/config.py", 10),
      ];
      const [a, b] = await inBothOrders(onlyNear, (c) => full(c, `Config${sep}load`));
      for (const r of [a, b]) expect(r.resolved || ("ambiguous" in r && r.ambiguous)).toBe(false);

      const withExact = [...onlyNear, node("lb", "load", "method", "b/config.py", 10)];
      const [c1, c2] = await inBothOrders(withExact, (c) => full(c, `Config${sep}load`));
      for (const r of [c1, c2]) {
        expect(r.resolved && r.entity.id).toBe("lb");
        expect(r.resolved && r.entity.name).toBe(`Config${sep}load`);
      }
    });

    it(`Single${sep}load ignores a fuzzy method in the one class's file`, async () => {
      const single = [
        node("s", "Single", "class", "src/single.py", 1),
        node("ldr", "loader", "method", "src/single.py", 10),
      ];
      const r = await full(client(single), `Single${sep}load`);
      expect(r.resolved || ("ambiguous" in r && r.ambiguous)).toBe(false);
    });
  }

  it("a qualified name whose class is not found stays a miss", async () => {
    const r = await full(client(nodes), "Nope.expand");
    expect(r.resolved).toBe(false);
  });
});

/** The fake backend plus the graph's CONTAINS edges (class id -> member ids). */
function clientWithContains(nodes: Node[], contains: Record<string, string[]>) {
  const c = client(nodes);
  c.expand = vi.fn(async (id: string) => ({
    nodes: (contains[id] ?? []).map((m) => nodes.find((n) => n.id === m)).filter(Boolean),
    edges: [],
  }));
  return c;
}

describe("Class.method must be a member of the class (round 4)", () => {
  for (const sep of [".", "#"]) {
    it(`Config${sep}load: a load in a file whose path contains the class's file is not returned`, async () => {
      // `xa/config.ts` contains the substring `a/config.ts` and the old basename
      // hint `config`; neither makes its `load` a member of a/config.ts's Config.
      const nodes = [
        node("ca", "Config", "class", "a/config.ts", 1),
        node("other", "load", "method", "xa/config.ts", 10),
      ];
      for (const c of [client(nodes), clientWithContains(nodes, { ca: [] })]) {
        const r = await full(c, `Config${sep}load`);
        expect(r.resolved).toBe(false);
        expect(!r.resolved && r.ambiguous).toBe(false);
      }
    });

    it(`Config${sep}load resolves to the class's own load, from CONTAINS or the same file`, async () => {
      const nodes = [
        node("ca", "Config", "class", "a/config.ts", 1),
        node("own", "load", "method", "a/config.ts", 10),
        node("other", "load", "method", "xa/config.ts", 10),
      ];
      const viaFile = await inBothOrders(nodes, (c) => full(c, `Config${sep}load`));
      const viaGraph = await inBothOrders(nodes, (c) =>
        full(Object.assign(c, { expand: clientWithContains(nodes, { ca: ["own"] }).expand }), `Config${sep}load`));
      for (const r of [...viaFile, ...viaGraph]) {
        expect(r.resolved && r.entity.id).toBe("own");
        expect(r.resolved && r.entity.name).toBe(`Config${sep}load`);
      }
    });

    it(`Config${sep}load: CONTAINS rules out a same-file load that belongs to another class`, async () => {
      const nodes = [
        node("ca", "Config", "class", "a/config.ts", 1),
        node("cx", "Loader", "class", "a/config.ts", 50),
        node("theirs", "load", "method", "a/config.ts", 60),
        node("save", "save", "method", "a/config.ts", 10),
      ];
      const c = clientWithContains(nodes, { ca: ["save"], cx: ["theirs"] });
      const r = await full(c, `Config${sep}load`);
      expect(r.resolved || (!r.resolved && r.ambiguous)).toBe(false);
      expect(c.expand).toHaveBeenCalledWith("ca", expect.objectContaining({ predicates: ["CONTAINS"] }));
    });

    it(`Config${sep}load prints exactly one miss line in text mode`, async () => {
      const nodes = [
        node("ca", "Config", "class", "a/config.ts", 1),
        node("other", "load", "method", "xa/config.ts", 10),
      ];
      const r = await full(client(nodes), `Config${sep}load`, { format: "text" });
      expect(r.resolved).toBe(false);
      const misses = errs.join("").split("\n").filter((l) => /No entity/.test(l));
      expect(misses).toEqual([`No entity found matching "Config${sep}load".`]);
    });
  }
});

describe("a tie notice lists only the true ties (round 4)", () => {
  // class and interface tie at the top score; the module scores lower but
  // within the old +5 window, so it used to be counted as "equal".
  const nodes = [
    node("cls", "Parser", "class", "src/a.ts"),
    node("ifc", "Parser", "interface", "src/b.ts"),
    node("mod", "Parser", "module", "src/c.ts"),
  ];

  it("total, candidates and --pick cover the top tier; the near-miss is only counted", async () => {
    const [a, b] = await inBothOrders(nodes, (c) => full(c, "Parser"));
    for (const r of [a, b]) {
      if (!r.resolved) throw new Error("expected resolved");
      expect(r.entity.id).toBe("cls");
      const n = r.notices?.[0];
      expect(n?.code).toBe("ambiguous_target");
      expect(n?.total).toBe(2);
      expect(n?.candidates.map((c) => c.id)).toEqual(["cls", "ifc"]);
      expect(n?.message).toContain("matches 2 candidates equally");
      expect(n?.message).toContain("1 more scored lower and is not listed.");
    }
    const picked = await full(client(nodes), "Parser", { pick: 2 });
    expect(picked.resolved && picked.entity.id).toBe("ifc");
    const outOfRange = await full(client(nodes), "Parser", { pick: 3 });
    expect(outOfRange.resolved && outOfRange.entity.id).toBe("cls");
    expect(errs.join("")).toContain("--pick 3 is out of range (1-2).");
    expect(process.exitCode).toBeUndefined();
  });

  it("llm: shown= and total= match the listed candidates", async () => {
    expect(await resolveFileOrReport(client(nodes), "Parser", {}, "llm")).not.toBeNull();
    const lines = logs.join("\n").split("\n");
    expect(lines[0]).toMatch(/^diagnostic code=ambiguous_target target=Parser .*shown=2 total=2/);
    expect(lines.filter((l) => l.startsWith("candidate "))).toHaveLength(2);
  });
});

describe("--pick among fuzzy candidates stays fuzzy", () => {
  it("an ambiguous fuzzy set picked with --pick is labelled fuzzy with a notice", async () => {
    const nodes = [
      node("r1", "runAlpha", "function", "src/a.ts"),
      node("r2", "runBeta", "function", "src/b.ts"),
    ];
    const base = await full(client(nodes), "run");
    expect(base.resolved).toBe(false);
    const r = await full(client(nodes), "run", { pick: 2 });
    if (!r.resolved) throw new Error("expected resolved");
    expect(r.entity.id).toBe("r2");
    expect(r.entity.resolutionMode).toBe("fuzzy");
    expect(r.notices?.[0].code).toBe("fuzzy_match");
    expect(r.notices?.[0].chosen.id).toBe("r2");
  });
});

describe("a fuzzy literal hit does not hide the qualified reading", () => {
  it("Config.load prefers the class member over a fuzzy literal Config.loadAll", async () => {
    const nodes = [
      node("entry", "Config.loadAll", "config_entry", "conf/app.toml", 3),
      node("ca", "Config", "class", "a/config.ts", 1),
      node("own", "load", "method", "a/config.ts", 10),
    ];
    const [a, b] = await inBothOrders(nodes, (c) => full(c, "Config.load"));
    for (const r of [a, b]) expect(r.resolved && r.entity.id).toBe("own");
  });

  it("keeps the fuzzy literal (exit 0) when the qualified reading misses", async () => {
    const nodes = [
      node("entry", "Config.loadAll", "config_entry", "conf/app.toml", 3),
      node("ca", "Config", "class", "a/config.ts", 1),
    ];
    const r = await full(client(nodes), "Config.load");
    expect(r.resolved && r.entity.id).toBe("entry");
    expect(r.resolved && r.entity.resolutionMode).toBe("fuzzy");
  });
});

describe("a method whose name ends in a file extension (review round 5)", () => {
  for (const [cls, method] of [["Response", "json"], ["Template", "html"], ["Tree", "go"]]) {
    const target = `${cls}.${method}`;

    it(`${target} with no such file resolves to the class member`, async () => {
      const nodes = [
        node("cls", cls, "class", `src/${cls.toLowerCase()}.ts`, 1),
        node("m", method, "method", `src/${cls.toLowerCase()}.ts`, 10),
        node("other", method, "method", "src/other.ts", 10),
      ];
      const [a, b] = await inBothOrders(nodes, (c) => full(c, target));
      for (const r of [a, b]) {
        expect(r.resolved && r.entity.id).toBe("m");
        expect(r.resolved && r.entity.name).toBe(target);
      }
      expect(process.exitCode).toBeUndefined();
    });

    it(`${target} is still the file when a file has that name`, async () => {
      const nodes = [
        file(`assets/${target}`),
        node("cls", cls, "class", `src/${cls.toLowerCase()}.ts`, 1),
        node("m", method, "method", `src/${cls.toLowerCase()}.ts`, 10),
      ];
      const [a, b] = await inBothOrders(nodes, (c) => full(c, target));
      for (const r of [a, b]) {
        expect(r.resolved && r.entity.kind).toBe("file");
        expect(r.resolved && r.entity.path).toBe(`assets/${target}`);
      }
    });
  }

  it("with neither the file nor the member it is still a file miss", async () => {
    const nodes = [node("cls", "Response", "class", "src/response.ts", 1)];
    const r = await full(client(nodes), "Response.json");
    expect(r.resolved).toBe(false);
    expect(!r.resolved && !r.ambiguous && r.reason).toBe("file_not_found");
  });
});

describe("acceptance 6: fuzzy matches are labelled", () => {
  const nodes = [
    node("fn", "reparseConfig", "function", "src/parse-pool.ts", 3),
    node("m", "expand", "method", "src/client/api.ts", 20),
  ];

  it("`parse` resolves to reparseConfig as fuzzy, with a fuzzy_match notice, exit 0", async () => {
    const [a, b] = await inBothOrders(nodes, (c) => full(c, "parse"));
    for (const r of [a, b]) {
      expect(r.resolved && r.entity.id).toBe("fn");
      expect(r.resolved && r.entity.resolutionMode).toBe("fuzzy");
      expect(r.resolved && r.notices?.map((n) => n.code)).toEqual(["fuzzy_match"]);
    }
    expect(process.exitCode).toBeUndefined();
  });

  it("llm: resolution=fuzzy, and the output never starts with `error code=`", async () => {
    expect(await resolveFileOrReport(client(nodes), "parse", {}, "llm")).not.toBeNull();
    expect(process.exitCode).toBeUndefined();
    expect(logs[0]).toMatch(/^diagnostic code=fuzzy_match resolution=fuzzy/);
    expect(logs.join("\n")).not.toMatch(/^error code=/);
  });

  it("json: resolutionMode fuzzy and resolutionNotices merge into the command's object", async () => {
    expect(await resolveFileOrReport(client(nodes), "parse", {}, "json")).not.toBeNull();
    printJson({ results: [] });
    const out = JSON.parse(logs[0]);
    expect(out.results).toEqual([]);
    expect(out.resolutionMode).toBe("fuzzy");
    expect(out.resolutionNotices[0].code).toBe("fuzzy_match");
    expect(process.exitCode).toBeUndefined();
  });

  it("`expan` keeps resolving and is labelled fuzzy", async () => {
    const r = await full(client(nodes), "expan");
    expect(r.resolved && r.entity.resolutionMode).toBe("fuzzy");
  });
});

describe("acceptance 7: many methods named run", () => {
  const runs = (n: number) => Array.from({ length: n }, (_, i) =>
    node(`run-${String(i).padStart(2, "0")}`, "run", "method", `src/m${String(i).padStart(2, "0")}.ts`, 4));

  it("40 of them (window 30): exit 1 as before, 8 shown, total=30, truncated", async () => {
    const nodes = runs(40);
    logs.length = 0;
    expect(await resolveFileOrReport(client(nodes), "run", {}, "json")).toBeNull();
    expect(process.exitCode).toBe(2);
    const out = JSON.parse(logs[0]);
    expect(out.error).toBe("ambiguous_target");
    expect(out.candidates).toHaveLength(8);
    expect(out.total).toBe(30);
    expect(out.truncated).toBe(true);
  });

  it("20 of them: --pick 3 gives the same id in both orders", async () => {
    const [a, b] = await inBothOrders(runs(20), (c) => full(c, "run", { pick: 3 }));
    expect(a.resolved && b.resolved).toBe(true);
    expect(a.resolved && b.resolved && a.entity.id === b.entity.id).toBe(true);
  });
});

describe("modes and notices", () => {
  it("ResolutionMode vs resolutionMode is not reported exact", async () => {
    const r = await full(client([node("p", "resolutionMode", "field", "src/a.ts")]), "ResolutionMode");
    expect(r.resolved && r.entity.resolutionMode).not.toBe("exact");
  });

  it("--kind no longer forces exact", async () => {
    const r = await full(client([node("p", "Parse", "function", "src/a.ts")]), "parse", { kind: "function" });
    expect(r.resolved && r.entity.resolutionMode).not.toBe("exact");
  });

  it("a case-sensitive exact name stays exact", async () => {
    const r = await full(client([node("p", "parse", "function", "src/a.ts")]), "parse");
    expect(r.resolved && r.entity.resolutionMode).toBe("exact");
  });

  it("the json notice merges into an object but never into an {error} record", () => {
    resetResolutionNotices();
    const notice = { code: "ambiguous_target", total: 2 };
    // (reportResolutionNotices queues through the same store)
    return import("../format.js").then(({ noteResolutionNotices }) => {
      noteResolutionNotices([notice]);
      printJson({ error: "boom", message: "x" });
      expect(JSON.parse(logs[0])).toEqual({ error: "boom", message: "x" });
      printJson({ ok: true });
      expect(JSON.parse(logs[1])).toEqual({ ok: true });
    });
  });

  it("an out-of-range --pick on a notice keeps the default and exit 0", async () => {
    const r = await full(client(PACKAGES), "index.ts", { pick: 9 });
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.notices?.[0].diagnostics?.[0].code).toBe("pick_out_of_range");
    expect(process.exitCode).toBeUndefined();
    expect(errs.join("\n")).toContain("--pick 9 is out of range");
  });

  it("an ambiguity notice in llm is diagnostic, candidate and hint records, exit 0", async () => {
    expect(await resolveFileOrReport(client(PACKAGES), "index.ts", {}, "llm")).not.toBeNull();
    expect(process.exitCode).toBeUndefined();
    const lines = logs.join("\n").split("\n");
    expect(lines[0]).toMatch(/^diagnostic code=ambiguous_target target=index.ts .*shown=3 total=3/);
    expect(lines.filter((l) => l.startsWith("candidate "))).toHaveLength(3);
    expect(lines.some((l) => l.startsWith("hint ") && l.includes("--pick"))).toBe(true);
  });
});
