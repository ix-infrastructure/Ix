// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderEdgeResultsLlm, renderNodesLlm, sliceEdgeResults } from "../format.js";
import { renderSearchLlm } from "../commands/search.js";
import { renderInventoryLlm } from "../commands/inventory.js";
import { renderNote, renderSection, renderWarning } from "../ui.js";
import { parseFields, projectRow, setOutputShape } from "../output-shape.js";
import { registerOssCommands } from "../register/oss.js";

afterEach(() => setOutputShape({}));

function captured(fn: () => void): string[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}

const node = { id: "abcdef1234567890", kind: "function", name: "relativePath" };

describe("--fields", () => {
  it("parses a list, and nothing from nothing", () => {
    expect(parseFields("name,path,lines")).toEqual(["name", "path", "lines"]);
    expect(parseFields(" name , path ")).toEqual(["name", "path"]);
    expect(parseFields("")).toBeUndefined();
    expect(parseFields(undefined)).toBeUndefined();
  });

  it("keeps the caller's order, not the renderer's", () => {
    // `--fields path,name` is a request for a column layout; answering it in
    // the renderer's order ignores half of what was asked.
    setOutputShape({ fields: "path,name" });
    expect(projectRow([["name", "a"], ["kind", "function"], ["path", "src/a.ts"]]))
      .toEqual([["path", "src/a.ts"], ["name", "a"]]);
  });

  it("drops a name no row carries rather than inventing it", () => {
    setOutputShape({ fields: "name,lines" });
    expect(projectRow([["name", "a"], ["kind", "function"]])).toEqual([["name", "a"]]);
  });

  it("shapes search rows", () => {
    setOutputShape({ fields: "name,path" });
    const lines = renderSearchLlm(
      [{ name: "relativePath", kind: "function", id: "abcdef1234567890", path: "src/format.ts", score: 0.83 }],
      1, [],
    );
    expect(lines[1]).toBe("node name=relativePath path=src/format.ts");
  });

  it("shapes edge rows and node rows", () => {
    setOutputShape({ fields: "name" });
    expect(renderNodesLlm([node])).toEqual(["node name=relativePath"]);
    const refs = renderEdgeResultsLlm(
      // #688 made this take a Slice rather than a bare array.
      sliceEdgeResults([{ id: "abcdef1234567890", name: "handleLogin", kind: "method", provenance: { source_uri: "src/a.ts" } }], 10),
      "callers", "verify", "graph",
    );
    expect(refs[1]).toBe("ref name=handleLogin");
  });

  it("shapes inventory rows", () => {
    setOutputShape({ fields: "path" });
    const lines = renderInventoryLlm("class", null, [
      { name: "Foo", kind: "class", provenance: { source_uri: "src/a.ts" } },
    ]);
    expect(lines[1]).toBe("file path=src/a.ts");
  });

  it("never touches the header, which is the answer's own bookkeeping", () => {
    // A projection that removed `total=` would make a partial list look
    // complete — the exact failure the truncation work exists to stop.
    setOutputShape({ fields: "name" });
    expect(renderSearchLlm([], 12, [])[0]).toBe("search count=0 candidates=12");
  });
});

describe("--quiet", () => {
  it("drops section titles and notes", () => {
    setOutputShape({ quiet: true });
    expect(captured(() => { renderSection("Evidence"); renderNote("run ix map"); })).toEqual([]);
  });

  it("keeps a warning, which is not decoration", () => {
    // A caller asking for less output is not asking to be told less about
    // something being wrong with the answer.
    setOutputShape({ quiet: true });
    expect(captured(() => renderWarning("source has changed"))).toHaveLength(1);
  });

  it("drops advisory diagnostics from a record stream", () => {
    setOutputShape({ quiet: true });
    const lines = renderSearchLlm([], 0, [{ code: "unfiltered_search", message: "broad" }]);
    expect(lines).toEqual(["search count=0 candidates=0"]);
  });

  it("keeps them when it was not asked to", () => {
    const lines = renderSearchLlm([], 0, [{ code: "unfiltered_search", message: "broad" }]);
    expect(lines).toHaveLength(2);
  });
});

describe("the flags themselves", () => {
  it("are on every command that renders an answer", () => {
    const program = new Command();
    program.name("ix");
    registerOssCommands(program);

    const pending = [...program.commands];
    const missing: string[] = [];
    while (pending.length > 0) {
      const command = pending.shift()!;
      pending.push(...command.commands);
      if (!command.options.some((o) => o.long === "--format")) continue;
      const has = (long: string) => command.options.some((o) => o.long === long);
      if (!has("--quiet") || !has("--fields")) missing.push(command.name());
    }
    expect(missing).toEqual([]);
  });

  it("are not on a command with no answer to shape", () => {
    const program = new Command();
    program.name("ix");
    registerOssCommands(program);
    const upgrade = program.commands.find((c) => c.name() === "upgrade")!;
    expect(upgrade.options.some((o) => o.long === "--quiet")).toBe(false);
  });
});
