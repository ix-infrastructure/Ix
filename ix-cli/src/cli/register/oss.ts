// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { OSS_COMMANDS } from "./commands.js";
import { applyOssSetup } from "./oss-setup.js";

export { registerProStubs } from "./pro-stubs.js";

/**
 * Every command module in the manifest, loaded while this module loads, so
 * `registerOssCommands()` stays synchronous for its callers (the MCP runner,
 * the doc scripts, an extension package). Importing this module is what costs:
 * the startup fast path (`register/oss-table.ts`) imports it only when it
 * needs every command.
 *
 * Loaded together rather than one after another; the order that matters is
 * the registration order below, which is the manifest's. No command module may
 * import this one, statically or otherwise during its own loading: this module
 * waits for it, and it would wait for this one.
 */
const registrations = await Promise.all(OSS_COMMANDS.map((entry) => entry.load()));

/**
 * Register every OSS command on `program`, in manifest order
 * (`register/commands.ts`), then the setup they share. Call before an
 * extension package registers its own: a name both register goes to the
 * first.
 */
export function registerOssCommands(program: Command): void {
  for (const register of registrations) register(program);
  applyOssSetup(program);
}
