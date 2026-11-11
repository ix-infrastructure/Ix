// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { formatOption } from "../options.js";
import { CAPABILITIES_SCHEMA, collectCapabilities, renderCapabilities } from "../capabilities.js";

/**
 * `ix capabilities`: what this CLI supports, for a plugin to read before it
 * calls anything else. With an explicit `--format`, `main.ts` answers it before
 * this module loads; this registration documents it and serves the rest
 * (no `--format`, `--help`).
 */
export function registerCapabilitiesCommand(program: Command): void {
  program
    .command("capabilities")
    .description("What this CLI supports: version, Ix Pro, hook entry points (no backend needed)")
    .addOption(formatOption())
    .addHelpText("after", `
For plugins and scripts: one cheap answer instead of probing with real
commands. Needs no backend and reads no config; Ix Pro is resolved, never
loaded or initialized.

  ix capabilities --format json
  {"schema":"${CAPABILITIES_SCHEMA}","version":"<semver>",
   "pro":{"available":false,"state":"absent"},"hooks":["claude-post-edit"]}

pro.state is absent, installed, or broken (installed but its entry point does
not resolve). installed is read from module resolution only: a Pro that then
fails to initialize still reads installed, and the next Pro command exits 1
saying so; treat that as Pro unavailable until ix upgrade. The answer changes only when the CLI or Ix Pro is reinstalled,
so cache it per resolved ix path and its modification time. A new field is
not a breaking change; a breaking one changes "schema". Exits 0 whenever it
answers.`)
    .action((opts: { format: string }) => {
      renderCapabilities(collectCapabilities(), opts.format);
    });
}
