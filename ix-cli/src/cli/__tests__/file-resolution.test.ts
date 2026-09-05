import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Verify that the shared file-first resolution helper exists
 * and that all graph navigation commands use it consistently.
 */

const resolveTsPath = path.resolve(__dirname, "../resolve.ts");
const resolveContent = fs.readFileSync(resolveTsPath, "utf-8");

const historyTsPath = path.resolve(__dirname, "../commands/history.ts");
const historyContent = fs.readFileSync(historyTsPath, "utf-8");

const diffTsPath = path.resolve(__dirname, "../commands/diff.ts");
const diffContent = fs.readFileSync(diffTsPath, "utf-8");

/** Commands that should all use resolveFileOrEntity for consistent file-path support. */
const COMMANDS_USING_FILE_RESOLUTION = [
  "overview", "callers", "contains", "imports", "depends", "locate", "impact", "explain",
];

const commandContents: Record<string, string> = {};
for (const cmd of COMMANDS_USING_FILE_RESOLUTION) {
  const cmdPath = path.resolve(__dirname, `../commands/${cmd}.ts`);
  commandContents[cmd] = fs.readFileSync(cmdPath, "utf-8");
}

describe("file-first resolution helper", () => {
  it("resolve.ts exports looksFileLike", () => {
    expect(resolveContent).toContain("export function looksFileLike");
  });

  it("resolve.ts exports resolveFileOrEntity", () => {
    expect(resolveContent).toContain("export async function resolveFileOrEntity");
  });

  it("resolveFileOrEntity tries file graph match before symbol resolution", () => {
    // The function should check looksFileLike first, then fall through to structured symbol resolution
    expect(resolveContent).toContain("looksFileLike(target)");
    expect(resolveContent).toContain("tryFileGraphMatch(client, target,");
    expect(resolveContent).toContain("resolveEntityFull(client, target,");
  });

  it("tryFileGraphMatch scores exact path matches higher than basename matches", () => {
    expect(resolveContent).toContain("quality: 0"); // exact path
    expect(resolveContent).toContain("quality: 1"); // exact filename
    expect(resolveContent).toContain("quality: 2"); // bare name
  });
});

describe("history command uses file-first resolution", () => {
  it("imports resolveFileOrReport", () => {
    expect(historyContent).toContain("resolveFileOrReport");
  });

  it("accepts a target argument, not entityId", () => {
    expect(historyContent).toContain('command("history <target>")');
  });

  it("supports --kind option", () => {
    expect(historyContent).toContain("--kind");
  });
});

describe("diff command supports scoped target", () => {
  it("accepts optional third positional argument", () => {
    expect(diffContent).toContain('command("diff <fromRev> <toRev> [target]")');
  });

  it("uses resolveFileOrReport for target resolution", () => {
    expect(diffContent).toContain("resolveFileOrReport");
  });

  it("passes resolved entity ID to diff API", () => {
    expect(diffContent).toContain("entityId");
  });

  it("supports --content flag for detailed attribute diffs", () => {
    expect(diffContent).toContain('"--content"');
    expect(diffContent).toContain("formatDiffContent");
  });

  it("--content reads source from disk using line spans", () => {
    expect(diffContent).toContain("readSourceSpan");
    expect(diffContent).toContain("line_start");
    expect(diffContent).toContain("line_end");
    expect(diffContent).toContain("fs.readFileSync");
  });

  it("--content augments JSON output with sourceContent", () => {
    expect(diffContent).toContain("sourceContent");
  });
});

describe("all graph commands use resolveFileOrEntity consistently", () => {
  for (const cmd of COMMANDS_USING_FILE_RESOLUTION) {
    it(`${cmd} uses file-first resolution`, () => {
      const helper = cmd === "locate" ? "resolveFileOrEntity" : "resolveFileOrReport";
      expect(commandContents[cmd]).toContain(helper);
    });
  }
});

describe("--pick support", () => {
  it("resolve.ts exports applyPick", () => {
    expect(resolveContent).toContain("export function applyPick");
  });

  it("resolve.ts delegates ambiguity output to the shared reporter", () => {
    expect(resolveContent).toContain("reportAmbiguousTarget(symbol, result, \"text\", opts)");
  });

  it("overview.ts declares --path option", () => {
    expect(commandContents["overview"]).toContain('"--path');
  });

  it("overview.ts declares --pick option", () => {
    expect(commandContents["overview"]).toContain('"--pick');
  });

  const PICK_COMMANDS = ["overview", "callers", "contains", "imports", "depends", "locate", "impact", "explain"];
  for (const cmd of PICK_COMMANDS) {
    it(`${cmd} declares --pick option`, () => {
      expect(commandContents[cmd]).toContain("--pick");
    });
  }
});

describe("ambiguous result structure", () => {
  it("resolve.ts AmbiguousResult includes rank field", () => {
    expect(resolveContent).toContain("rank?:");
  });

  it("resolve.ts AmbiguousResult includes diagnostics field", () => {
    expect(resolveContent).toContain("diagnostics?:");
  });

  it("buildAmbiguous sets rank on candidates", () => {
    expect(resolveContent).toContain("rank,");
  });

  it("buildAmbiguous sets diagnostics with ambiguous_resolution code", () => {
    expect(resolveContent).toContain("ambiguous_resolution");
  });
});
