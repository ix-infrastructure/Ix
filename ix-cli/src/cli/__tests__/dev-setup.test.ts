// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const setup = fileURLToPath(new URL("../../../../scripts/dev/setup.sh", import.meta.url));
const cli = fileURLToPath(new URL("../main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));

describe.skipIf(process.platform === "win32")("developer setup next steps", () => {
  it.each(["help", "completion"])("prints supported commands in %s output", (mode) => {
    const fixture = mkdtempSync(join(process.cwd(), ".dev-setup-test-"));
    try {
      mkdirSync(join(fixture, "scripts/dev"), { recursive: true });
      mkdirSync(join(fixture, "bin"));
      copyFileSync(setup, join(fixture, "scripts/dev/setup.sh"));
      // Exercise the completion path without starting Docker or building/installing the CLI.
      for (const script of ["scripts/backend.sh", "scripts/build-cli.sh", "bin/docker"]) {
        writeFileSync(join(fixture, script), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      }
      const output = execFileSync("bash", [join(fixture, "scripts/dev/setup.sh"),
        ...(mode === "help" ? ["--help"] : ["--skip-global-ix"])], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(fixture, "bin")}${delimiter}${process.env.PATH}` },
      });

      expect(output).toContain("ix map ~/my-project");
      expect(output).toContain("ix mcp install");
      expect(output).not.toMatch(/scripts\/(connect|disconnect|ingest|init-project|dev\/shutdown)\.sh/);
      if (mode === "help") expect(output).toContain("Usage: ./scripts/dev/setup.sh");

      // Check the printed commands against the real CLI parser, without running their actions.
      for (const command of output.matchAll(/^\s+ix (map ~\/my-project|mcp install)\s*$/gm)) {
        const help = execFileSync(process.execPath, [tsx, cli, ...command[1].split(" "), "--help"], {
          encoding: "utf8",
        });
        expect(help).toContain("Usage:");
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
