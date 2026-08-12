import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classifyDefinition, classifyListing, type McpHost, type Registration } from "../../mcp/hosts.js";
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
  options: { installed?: boolean; fails?: boolean } = {},
): McpHost & { registerCalls: number } {
  const host = {
    id,
    label: id,
    bin: options.installed === false ? "definitely-not-a-real-binary-xyz" : "node",
    target: `${id}-config`,
    registerCalls: 0,
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

  it("recognises a pretty-printed definition split across lines", () => {
    // `openclaw mcp show` puts "ix" and "mcp" on separate lines; matching one
    // line at a time reads our own entry as a stranger's.
    const shown = 'MCP server "ix-memory":\n{\n  "command": "ix",\n  "args": [\n    "mcp"\n  ]\n}';

    expect(classifyDefinition(shown).registration).toBe("ours");
    expect(classifyListing(shown).registration).toBe("other");
  });
});
