import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ADD_ARGS,
  classifyDefinition,
  classifyListing,
  classifyShown,
  pickWindowsLauncher,
  quoteForCmd,
  type McpHost,
  type Registration,
} from "../../mcp/hosts.js";
import { IX_MCP_OSS_TOOL_NAMES, IX_MCP_PRO_TOOL_NAMES } from "../../mcp/server.js";
import { runDoctor, runInstall, writeJsonConfig } from "../../mcp/install.js";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ix-mcp-install-"));
  scratch.push(dir);
  return dir;
}

/**
 * `node` stands in for an installed host and a name that cannot exist stands in
 * for a missing one, so the PATH probe runs for real rather than being stubbed.
 */
function fakeHost(
  id: string,
  registration: Registration,
  options: { installed?: boolean; fails?: boolean; detectInstalled?: () => Promise<boolean> } = {},
): McpHost & { registerCalls: number } {
  const host = {
    id,
    label: id,
    bin: options.installed === false ? "definitely-not-a-real-binary-xyz" : "node",
    target: `${id}-config`,
    registerCalls: 0,
    ...(options.detectInstalled ? { detectInstalled: options.detectInstalled } : {}),
    async inspect() {
      return { registration };
    },
    async register() {
      host.registerCalls += 1;
      if (options.fails) throw new Error("host CLI said no");
    },
  };
  return host;
}

describe("ix mcp install", () => {
  it("registers a host whose name is free", async () => {
    const host = fakeHost("free", "none");

    const report = await runInstall({ hosts: [host] });

    expect(host.registerCalls).toBe(1);
    expect(report.hosts[0]).toMatchObject({ outcome: "registered", installed: true });
    expect(report.registered).toBe(1);
  });

  it("never overwrites a name held by a different server", async () => {
    const host = fakeHost("taken", "other");

    const report = await runInstall({ hosts: [host] });

    expect(host.registerCalls).toBe(0);
    expect(report.hosts[0]?.outcome).toBe("conflict");
    expect(report.conflicts).toBe(1);
  });

  it("treats an unreadable registration as occupied rather than free", async () => {
    const host = fakeHost("murky", "unknown");

    const report = await runInstall({ hosts: [host] });

    // Guessing "free" here is the one wrong guess that destroys a config.
    expect(host.registerCalls).toBe(0);
    expect(report.hosts[0]?.outcome).toBe("conflict");
  });

  it("replaces a conflicting registration only when --force is given", async () => {
    const host = fakeHost("taken", "other");

    const report = await runInstall({ hosts: [host], force: true });

    expect(host.registerCalls).toBe(1);
    expect(report.hosts[0]?.outcome).toBe("registered");
  });

  it("is idempotent when the name already points at ix mcp", async () => {
    const host = fakeHost("ours", "ours");

    const report = await runInstall({ hosts: [host] });

    expect(host.registerCalls).toBe(0);
    expect(report.hosts[0]?.outcome).toBe("already-registered");
  });

  it("writes nothing under --dry-run", async () => {
    const hosts = [fakeHost("a", "none"), fakeHost("b", "other")];

    const report = await runInstall({ hosts, dryRun: true });

    expect(hosts.map((h) => h.registerCalls)).toEqual([0, 0]);
    expect(report.hosts.map((h) => h.outcome)).toEqual(["would-register", "conflict"]);
  });

  it("skips hosts that are not installed", async () => {
    const host = fakeHost("absent", "none", { installed: false });

    const report = await runInstall({ hosts: [host] });

    expect(host.registerCalls).toBe(0);
    expect(report.hosts[0]).toMatchObject({ outcome: "not-installed", installed: false });
  });

  it("reports a failing host without aborting the rest", async () => {
    const hosts = [fakeHost("broken", "none", { fails: true }), fakeHost("fine", "none")];

    const report = await runInstall({ hosts });

    expect(report.hosts.map((h) => h.outcome)).toEqual(["failed", "registered"]);
    expect(report.hosts[0]?.note).toContain("host CLI said no");
  });

  it("honours the host filter", async () => {
    const hosts = [fakeHost("a", "none"), fakeHost("b", "none")];

    const report = await runInstall({ hosts, only: ["b"] });

    expect(report.hosts.map((h) => h.id)).toEqual(["b"]);
    expect(hosts[0]!.registerCalls).toBe(0);
  });

  it("rejects an unknown host id instead of reporting a silent success", async () => {
    const hosts = [fakeHost("claude", "none")];

    // Filtering everything out and returning `registered: 0` let a typo in a
    // setup script register nothing and still exit 0.
    await expect(runInstall({ hosts, only: ["claude-code"] })).rejects.toThrow(/unknown host 'claude-code'/);
    await expect(runDoctor({ hosts, only: ["vs-code"] })).rejects.toThrow(/unknown host/);
    expect(hosts[0]!.registerCalls).toBe(0);
  });

  it("repairs a registration whose launcher path is gone, without --force", async () => {
    const host = fakeHost("moved", "stale");

    const report = await runInstall({ hosts: [host] });

    // Still ours, so nothing of the user's is at risk — and re-resolving the
    // path is the only thing that fixes it. Reported as healthy, install
    // skipped the one host it should have rewritten.
    expect(host.registerCalls).toBe(1);
    expect(report.hosts[0]?.outcome).toBe("registered");
  });

  it("consults a host's own installed check before falling back to PATH", async () => {
    // Cursor and VS Code are read and written through config files; their shell
    // shims are opt-in and say nothing about whether the editor is there.
    const host = fakeHost("cursor", "none", {
      installed: false,
      detectInstalled: async () => true,
    });

    const report = await runInstall({ hosts: [host] });

    expect(report.hosts[0]).toMatchObject({ outcome: "registered", installed: true });
    expect(host.registerCalls).toBe(1);
  });
});

describe("ix mcp doctor", () => {
  it("separates a free name from one held by someone else", async () => {
    const report = await runDoctor({
      hosts: [fakeHost("free", "none"), fakeHost("taken", "other"), fakeHost("ours", "ours")],
    });

    expect(report.hosts.map((h) => h.outcome)).toEqual([
      "not-registered",
      "conflict",
      "already-registered",
    ]);
    // Pro is resolvable on some machines and not others, so the count is one
    // of exactly two values rather than a fixed number.
    expect([
      IX_MCP_OSS_TOOL_NAMES.length,
      IX_MCP_OSS_TOOL_NAMES.length + IX_MCP_PRO_TOOL_NAMES.length,
    ]).toContain(report.toolCount);
  });
});

describe("ix mcp doctor reporting", () => {
  it("names a dead launcher rather than calling it registered", async () => {
    const report = await runDoctor({ hosts: [fakeHost("moved", "stale")] });

    // `= already registered` plus `+ ix on PATH` was the report a user got
    // while every client failed to load a single Ix tool.
    expect(report.hosts[0]?.outcome).toBe("stale");
    expect(report.hosts[0]?.note).toMatch(/launcher/);
  });
});

describe("writeJsonConfig", () => {
  it("keeps every unrelated key and backs up what was there", () => {
    const dir = tempDir();
    const path = join(dir, "opencode.json");
    writeFileSync(path, JSON.stringify({ $schema: "x", plugin: ["./p.ts"] }, null, 2));

    writeJsonConfig(path, (config) => {
      (config.mcp as unknown) = { "ix-memory": { type: "local", command: ["ix", "mcp"] } };
    });

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.$schema).toBe("x");
    expect(written.plugin).toEqual(["./p.ts"]);
    expect(written.mcp["ix-memory"].command).toEqual(["ix", "mcp"]);
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8"))).toEqual({ $schema: "x", plugin: ["./p.ts"] });
  });

  it("creates the file and its directory when absent", () => {
    const path = join(tempDir(), "nested", "mcp.json");

    writeJsonConfig(path, (config) => {
      (config.mcpServers as unknown) = { "ix-memory": { command: "ix", args: ["mcp"] } };
    });

    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers["ix-memory"].command).toBe("ix");
    // Nothing was replaced, so there is nothing to back up.
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it("treats a zero-byte file as empty rather than corrupt", () => {
    const path = join(tempDir(), "mcp.json");
    // The state VS Code ships this file in until something writes it.
    writeFileSync(path, "");

    writeJsonConfig(path, (config) => {
      (config.servers as unknown) = { "ix-memory": { command: "ix" } };
    });

    expect(JSON.parse(readFileSync(path, "utf8")).servers["ix-memory"].command).toBe("ix");
  });

  it("accepts the JSON-with-comments the read path already accepts", () => {
    const path = join(tempDir(), "mcp.json");
    // Valid for Cursor, and `inspect` reads it happily. The write path parsed
    // it raw, so install reported the name free and then hard-failed, telling
    // the user to fix a file their editor reads without complaint.
    writeFileSync(
      path,
      ['{', '  // my servers', '  "mcpServers": { "theirs": { "command": "other" } }', "}", ""].join("\n"),
    );

    writeJsonConfig(path, (config) => {
      const servers = (config.mcpServers ??= {}) as Record<string, unknown>;
      servers["ix-memory"] = { command: "ix", args: ["mcp"] };
    });

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.mcpServers.theirs.command).toBe("other");
    expect(written.mcpServers["ix-memory"].command).toBe("ix");
    // The comments are gone, which is what the .bak is for.
    expect(readFileSync(`${path}.bak`, "utf8")).toContain("// my servers");
  });

  it("refuses to overwrite a file it cannot parse", () => {
    const path = join(tempDir(), "mcp.json");
    writeFileSync(path, "{ this is not json");

    expect(() => writeJsonConfig(path, () => {})).toThrow(/not valid JSON/);
    // The user's content must still be there after the refusal.
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });

  // Needs a read to fail where the write would have succeeded. Permission bits
  // give that only on POSIX and only for a non-root caller: root bypasses them,
  // and on Windows chmod moves the read-only flag, which blocks the write too.
  const readCanFailAlone =
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

  it.skipIf(!readCanFailAlone)("surfaces an unreadable config instead of overwriting it", () => {
    // Write-only: the read fails, the write would go through. That is the one
    // shape where collapsing "unreadable" into "absent" is destructive — the
    // mkdir-and-write branch replaces a config we never managed to read, and
    // leaves no `.bak`, because the copy only runs on the branch that read one.
    const path = join(tempDir(), "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { theirs: { command: "other" } } }));
    chmodSync(path, 0o200);

    expect(() =>
      writeJsonConfig(path, (config) => {
        (config.mcpServers as unknown) = { "ix-memory": { command: "ix" } };
      }),
    ).toThrow(/EACCES/);

    chmodSync(path, 0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.theirs.command).toBe("other");
    expect(existsSync(`${path}.bak`)).toBe(false);
  });
});

describe("registration classification", () => {
  it("reads a codex table row pointing at ix mcp as ours", () => {
    expect(classifyListing("ix-memory  ix  mcp  -  -  enabled").registration).toBe("ours");
  });

  it("reads the bespoke python server under the same name as someone else's", () => {
    const listing = "ix-memory  python3  /home/u/.codex/mcp/server.py  -  -  enabled";

    expect(classifyListing(listing).registration).toBe("other");
  });

  it("ignores loader diagnostics that happen to name the server", () => {
    // Gemini prints ~28 lines of these before the listing, and its extension is
    // itself called ix-memory.
    const listing = [
      "[ExtensionManager] Error loading agent from ix-memory: Failed to load agent",
      "tools.0: Invalid tool name",
      "Configured MCP servers:",
      "✗ ix-memory (from ix-memory): node dist/server.js (stdio) - Disconnected",
    ].join("\n");

    expect(classifyListing(listing)).toMatchObject({
      registration: "other",
      detail: expect.stringContaining("node dist/server.js"),
    });
  });

  it("reports nothing registered when the name never appears", () => {
    expect(classifyListing("some-other-server: npx thing").registration).toBe("none");
  });

  it.each([
    String.raw`C:\Users\gone\AppData\Roaming\npm\ix.cmd`,
    // A Windows username with a space is the common case, not the edge one; a
    // first attempt that recovered the path by regex stopped at the space and
    // read this as healthy — for most of the users the check was written for.
    String.raw`C:\Users\Jane Doe\AppData\Roaming\npm\ix.cmd`,
    String.raw`C:\Program Files\nodejs\ix.cmd`,
    "/opt/my tools/bin/ix",
  ])("reports %s as stale once it no longer resolves", (command) => {
    // What a registration looks like after an nvm switch or a reinstall to a
    // different prefix. Read as healthy, install skipped the one host it should
    // have repaired while doctor agreed it was fine.
    expect(classifyListing(`ix-memory ${JSON.stringify({ command, args: ["mcp"] })}`, command)).toMatchObject({
      registration: "stale",
      detail: expect.stringContaining("no longer exists"),
    });
  });

  it("keeps an absolute launcher that does resolve as ours", () => {
    // Written under a directory with a space in it, so this cannot pass merely
    // by failing to recognise the path as a path.
    const dir = join(tempDir(), "my tools");
    mkdirSync(dir, { recursive: true });
    const launcher = join(dir, "ix.cmd");
    writeFileSync(launcher, "@echo off");

    expect(
      classifyListing(`ix-memory ${JSON.stringify({ command: launcher, args: ["mcp"] })}`, launcher).registration,
    ).toBe("ours");
  });

  // Windows-only by nature: a UNC path is a network location there, and stat
  // fails on it with something other than ENOENT. Everywhere else those
  // backslashes are ordinary filename characters, so the path really is absent
  // and `stale` is the right answer.
  it.skipIf(process.platform !== "win32")("leaves a launcher it cannot conclusively stat alone", () => {
    // A file server being offline is not evidence the launcher is gone, and
    // `stale` triggers a rewrite with no --force, so only ENOENT counts.
    const unc = String.raw`\\server-that-does-not-exist\share\npm\ix.cmd`;

    expect(classifyListing(`ix-memory ${JSON.stringify({ command: unc, args: ["mcp"] })}`, unc).registration).toBe(
      "ours",
    );
  });

  it("does not invent a stale launcher out of a suffix of a live path", () => {
    // A launcher that genuinely exists, sitting under a `.../npm/ix.cmd` tail.
    // A regex allowed to start at an interior `/` matched only that tail,
    // stat'd `/npm/ix.cmd` from the filesystem root, found nothing, and called
    // a working registration stale — so `install` rewrote it with no --force
    // and `doctor` exited 1 on a healthy machine. The fixture has to use a path
    // that exists, or it cannot tell the two behaviours apart.
    const dir = join(tempDir(), "Program Files", "npm");
    mkdirSync(dir, { recursive: true });
    const launcher = join(dir, "ix.cmd");
    writeFileSync(launcher, "@echo off");
    // Both properties are needed to reproduce it: the space stops an
    // unanchored match from spanning the path from its start, and the forward
    // slashes then give it an interior `/npm/ix.cmd` to latch onto instead.
    // A temp path without either cannot tell the two behaviours apart.
    const rendered = launcher.replaceAll("\\", "/");

    expect(classifyListing(`ix-memory  ${rendered}  mcp  -  enabled`).registration).toBe("ours");
  });

  // Every row format a host actually prints, and every launcher shape that has
  // broken one attempt or another at recovering the path back out of the row:
  // a space, parentheses, brackets, a comma, a wrapper prefix, quotes. All of
  // them name the launcher we would write today, so all of them are healthy —
  // and each was reported `stale` by some iteration of the parsing approach,
  // which re-registers with no --force over a config that was working.
  const HOST_ROWS: Array<[string, (p: string) => string]> = [
    ["claude mcp list", (p) => `ix-memory: ${p} mcp - ✓ Connected`],
    ["codex mcp list", (p) => `ix-memory  ${p}  mcp  -  -  enabled`],
    ["gemini mcp list", (p) => `✓ ix-memory (from ix-memory): ${p} mcp (stdio) - Connected`],
    ["a cmd wrapper", (p) => `ix-memory: cmd /c ${p} mcp - Connected`],
    ["a quoted path", (p) => `ix-memory: "${p}" mcp`],
  ];

  const LAUNCHER_SHAPES = [
    String.raw`C:\Users\Jane Doe\AppData\Roaming\npm\ix.cmd`,
    String.raw`C:\Program Files (x86)\nodejs\ix.cmd`,
    String.raw`C:\Users\J [work]\npm\ix.cmd`,
    String.raw`C:\Users\A, B\npm\ix.cmd`,
    "/opt/my tools/bin/ix",
  ];

  for (const [host, render] of HOST_ROWS) {
    it.each(LAUNCHER_SHAPES)(`reads %s in a ${host} row as ours`, (launcher) => {
      expect(classifyListing(render(launcher), null, launcher).registration).toBe("ours");
    });
  }

  it.each(HOST_ROWS)("spots a launcher that is no longer the current one in a %s row", (_host, render) => {
    // The npm prefix moved — an nvm switch, a reinstall elsewhere. The row
    // still names the old path, which is what makes every client fail to start
    // while install skips the repair and doctor calls it healthy.
    const recorded = String.raw`C:\Users\gone\AppData\Roaming\npm\ix.cmd`;
    const current = String.raw`C:\Users\now\AppData\Roaming\npm\ix.cmd`;

    expect(classifyListing(render(recorded), null, current)).toMatchObject({
      registration: "stale",
      detail: expect.stringContaining(current),
    });
  });

  it("ignores separator and case differences in how a host renders the path", () => {
    const current = String.raw`C:\Users\Me\AppData\Roaming\npm\ix.cmd`;

    expect(
      classifyListing("ix-memory: c:/users/me/appdata/roaming/npm/ix.cmd mcp", null, current).registration,
    ).toBe("ours");
  });

  it("does not judge staleness at all when the launcher is the bare name", () => {
    // Unix registers `ix`, which survives the install moving. Nothing to check.
    expect(classifyListing("ix-memory: ix mcp - Connected", null, "ix").registration).toBe("ours");
  });

  it("recognises a pretty-printed definition split across lines", () => {
    // `openclaw mcp show` puts "ix" and "mcp" on separate lines; matching one
    // line at a time reads our own entry as a stranger's.
    const shown = 'MCP server "ix-memory":\n{\n  "command": "ix",\n  "args": [\n    "mcp"\n  ]\n}';

    expect(classifyDefinition(shown).registration).toBe("ours");
    expect(classifyListing(shown).registration).toBe("other");
  });
});

describe("windows launcher resolution", () => {
  it("skips npm's extensionless POSIX shim, which CreateProcess cannot launch", () => {
    // The exact output of `where ix` on a machine with npm's shims: the
    // exact-name match comes first, and it is a `#!/bin/sh` script. Recording
    // it registered a command no host could start, in every host at once, while
    // `ix mcp doctor` still reported `+ ix on PATH`.
    const entries = [
      String.raw`C:\Users\me\AppData\Roaming\npm\ix`,
      String.raw`C:\Users\me\AppData\Roaming\npm\ix.cmd`,
    ];

    expect(pickWindowsLauncher(entries)).toBe(String.raw`C:\Users\me\AppData\Roaming\npm\ix.cmd`);
  });

  it("falls back to nothing when no entry is executable", () => {
    expect(pickWindowsLauncher([String.raw`C:\tools\ix`])).toBeUndefined();
  });
});

describe("quoteForCmd", () => {
  it("quotes a path with spaces and cmd metacharacters", () => {
    // A quoted region is literal to cmd, so `&` and `(` survive it. Unquoted,
    // cmd reads the `&` as a command separator.
    expect(quoteForCmd(String.raw`C:\Program Files\a&b(c)\ix.cmd`)).toBe(
      String.raw`"C:\Program Files\a&b(c)\ix.cmd"`,
    );
  });

  it.each([
    String.raw`C:\Users\R&D\npm\ix.cmd`,
    String.raw`C:\a^b\ix.cmd`,
    String.raw`C:\a|b\ix.cmd`,
  ])("quotes %s, which carries a metacharacter but no space", (path) => {
    // The case the test above cannot reach, because its fixture has a space and
    // so takes the quoting branch either way. A "does this need quoting?" check
    // that asks only about whitespace lets these through bare: verified by
    // round-trip that `C:\Users\R&D\npm\ix.cmd` then arrives as `C:\Users\R`
    // with cmd running `D\npm\ix.cmd` as a second command, and that
    // `C:\a^b\ix.cmd` arrives silently as `C:\ab\ix.cmd` — a wrong launcher
    // path written into every host config and reported as a success.
    expect(quoteForCmd(path)).toBe(`"${path}"`);
  });

  it("leaves an ordinary argument alone", () => {
    expect(quoteForCmd("--scope")).toBe("--scope");
  });
});

describe("classifyShown", () => {
  it("reads a host that could not answer as occupied, not free", () => {
    // openclaw's config is wedged, or its output format moved. Reading that as
    // an empty slot replaced the user's own server under our name, without
    // --force, and reported `+ registered`.
    expect(classifyShown("Error: failed to read config\n", false)).toMatchObject({
      registration: "unknown",
    });
  });

  it("still reads an explicit 'no such server' as free", () => {
    expect(classifyShown("No MCP server named ix-memory\n", false).registration).toBe("none");
  });

  it("does not read an unrelated 'not found' as free", () => {
    // A missing plugin, or the host's own loader failing. Neither says anything
    // about our name, and reading one as an empty slot writes over whatever the
    // user had — the very thing this function exists to prevent.
    expect(classifyShown("Error: plugin 'foo' not found\n", false).registration).toBe("unknown");
  });

  it("reads a definition body as ours", () => {
    const shown = 'MCP server "ix-memory":\n{\n  "command": "ix",\n  "args": ["mcp"]\n}';

    expect(classifyShown(shown, true).registration).toBe("ours");
  });
});

describe("host registration arguments", () => {
  it("pins gemini to user scope", () => {
    // `gemini mcp add` defaults to project scope, writing `<cwd>/.gemini/` —
    // invisible from every other directory, while the report named the
    // user-level file.
    expect(ADD_ARGS.gemini({ command: "ix", args: ["mcp"] })).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "ix-memory",
      "ix",
      "mcp",
    ]);
  });
});
