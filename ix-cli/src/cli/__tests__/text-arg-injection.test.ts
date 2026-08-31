import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const execFile = vi.hoisted(() =>
  vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) =>
    cb(null, { stdout: "", stderr: "" }),
  ),
);

// Spread the real module: `config.ts`, reached through this command, imports
// `execSync` from it.
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  execFile,
}));

import { registerTextCommand } from "../commands/text.js";

/**
 * `ix text` hands its search term straight to ripgrep's argv, and through
 * `ix mcp` that term is a string a model chose. Without a `--` separator rg
 * parses a leading `-` as one of its own flags, which is how `--files` ended up
 * running instead of a search, and how `--pre=<cmd>`/`--file=<path>` could take
 * the path argument away and leave rg reading stdin for ever.
 */
describe("ix text does not let the search term become an rg flag", () => {
  beforeEach(() => {
    execFile.mockClear();
  });

  async function argvFor(term: string, extra: string[] = []): Promise<string[]> {
    const program = new Command();
    registerTextCommand(program);
    await program.parseAsync(["text", ...extra, "--", term], { from: "user" });
    return execFile.mock.calls[0]?.[1] as string[];
  }

  it.each(["--files", "--pre=/bin/sh", "--file=/etc/passwd", "-l", "--no-ignore"])(
    "passes %s as a pattern, after the separator",
    async (term) => {
      const args = await argvFor(term);

      const sep = args.indexOf("--");
      expect(sep).toBeGreaterThanOrEqual(0);
      expect(args[sep + 1]).toBe(term);
      // Nothing before the separator came from the caller.
      expect(args.slice(0, sep)).not.toContain(term);
      // The path is still the last positional, so rg always has one and never
      // falls back to reading stdin.
      expect(args).toHaveLength(sep + 3);
    },
  );

  it("still places rg's own flags before the separator", async () => {
    const args = await argvFor("needle", ["--limit", "5", "--language", "python"]);

    expect(args.slice(0, args.indexOf("--"))).toEqual([
      "--json", "--max-count", "5", "--glob", "*.py",
    ]);
  });
});
