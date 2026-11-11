// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Command } from "commander";

import {
  addFormatOption,
  addPagingOptions,
  addTargetOptions,
  formatOption,
  pagingValues,
  STRICT_AMBIGUOUS_HELP,
  STRICT_TARGET_HELP,
  targetOptionValues,
} from "../options.js";
import { OFFSET_FLAG } from "../paging.js";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const commandsDir = join(cliDir, "commands");

/** Every command source plus the shared modules that declare options. */
function sources(): Array<{ file: string; text: string }> {
  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".ts")).map((f) => join(commandsDir, f));
  files.push(join(cliDir, "edge-command.ts"));
  return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

describe("shared option declarations", () => {
  // #936: the same flag declared with a copied help string in a dozen files
  // drifts. The help text of a shared option lives in options.ts only.
  const shared = [
    "Filter target entity by kind",
    "Restrict to symbols from files matching this path substring",
    "Pick Nth candidate from ambiguous results (1-based)",
    "Disable did-you-mean candidates on unresolved targets",
    "Max results to show",
    "Output format (text|json|llm)",
  ];

  it.each(shared)("no command re-declares %j", (help) => {
    const copies = sources().filter(({ text }) => text.includes(help)).map(({ file }) => file);
    expect(copies).toEqual([]);
  });

  it("no command declares --strict, --offset or --format by hand with the shared help", () => {
    const handwritten = /\.option\(\s*["']--(?:strict["'],\s*STRICT_|offset <n>["'],\s*OFFSET_FLAG|format <fmt>["'],\s*["']Output format \(text\|json(?:\|llm)?(?:\|silent)?\)["'])/;
    expect(sources().filter(({ text }) => handwritten.test(text)).map(({ file }) => file)).toEqual([]);
  });

  it("imports.ts and contains.ts have no action body of their own", () => {
    for (const file of ["imports.ts", "contains.ts"]) {
      expect(readFileSync(join(commandsDir, file), "utf8")).not.toContain(".action(");
    }
  });
});

describe("option helpers", () => {
  const flags = (cmd: Command) => cmd.options.map((o) => o.flags);

  it("addTargetOptions declares kind, path, pick, strict in that order", () => {
    expect(flags(addTargetOptions(new Command("x")))).toEqual(["--kind <kind>", "--path <path>", "--pick <n>", "--strict"]);
  });

  it("suggest puts --no-suggest between --path and --pick", () => {
    expect(flags(addTargetOptions(new Command("x"), { suggest: true })))
      .toEqual(["--kind <kind>", "--path <path>", "--no-suggest", "--pick <n>", "--strict"]);
  });

  it("--strict takes the shared help, or the ambiguity-only help when asked", () => {
    const strictHelp = (cmd: Command) => cmd.options.find((o) => o.long === "--strict")!.description;
    expect(strictHelp(addTargetOptions(new Command("x")))).toBe(STRICT_TARGET_HELP);
    expect(strictHelp(addTargetOptions(new Command("x"), { strictHelp: STRICT_AMBIGUOUS_HELP }))).toBe(STRICT_AMBIGUOUS_HELP);
  });

  it("parses --pick as a positive integer and rejects 0", async () => {
    const seen: unknown[] = [];
    const cmd = addTargetOptions(new Command("x")).exitOverride().configureOutput({ writeErr: () => {} })
      .action((opts) => { seen.push(targetOptionValues(opts)); });
    await cmd.parseAsync(["--pick", "2", "--kind", "class", "--strict"], { from: "user" });
    expect(seen).toEqual([{ kind: "class", path: undefined, pick: 2, strict: true }]);
    await expect(cmd.parseAsync(["--pick", "0"], { from: "user" })).rejects.toThrow(/positive integer/);
  });

  it("addPagingOptions keeps string defaults, and pagingValues turns them into numbers", () => {
    const cmd = addPagingOptions(new Command("x"), "20");
    const limit = cmd.options.find((o) => o.long === "--limit")!;
    const offset = cmd.options.find((o) => o.long === "--offset")!;
    expect([limit.flags, limit.description, limit.defaultValue]).toEqual(["--limit <n>", "Max results to show", "20"]);
    expect([offset.flags, offset.description, offset.defaultValue]).toEqual(["--offset <n>", OFFSET_FLAG, "0"]);
    expect(pagingValues({ limit: "20", offset: "0" })).toEqual({ limit: 20, offset: 0 });
    expect(pagingValues({ limit: "5", offset: "15" })).toEqual({ limit: 5, offset: 15 });
  });

  it("formatOption names the values it accepts, defaults to text and rejects anything else", async () => {
    const def = formatOption();
    expect([def.flags, def.description, def.defaultValue, def.argChoices])
      .toEqual(["--format <fmt>", "Output format (text|json|llm)", "text", ["text", "json", "llm"]]);
    const narrow = formatOption(["text", "json"]);
    expect([narrow.description, narrow.argChoices]).toEqual(["Output format (text|json)", ["text", "json"]]);

    const cmd = addFormatOption(new Command("x"), ["text", "json"]).exitOverride().configureOutput({ writeErr: () => {} }).action(() => {});
    await expect(cmd.parseAsync(["--format", "llm"], { from: "user" })).rejects.toThrow(/Allowed choices are text, json/);
  });

  it("each factory call is a fresh Option, so two commands never share one", () => {
    expect(formatOption()).not.toBe(formatOption());
  });
});
