import type { Command } from "commander";
import { createClient } from "../config.js";
import { formatPatches } from "../format.js";

/**
 * `ix patches`.
 *
 * This is the real implementation and has been all along — it was simply never
 * imported by `register/oss.ts`, while `patches` sat in `PRO_COMMANDS` so
 * `registerProStubs` installed the "requires Ix Pro" sentinel over the top of
 * it. OSS users got a paywall message for a command this repo implements (#371).
 *
 * `@ix/pro` also registers a `patches`. Commander throws on a duplicate command
 * name and Pro's `tryRegister` swallows the throw, so on a Kartr install the
 * OSS registration (which runs first, from `registerOssCommands`) is the one
 * that survives. That is the intended outcome — this version additionally
 * supports `--format llm` — but it makes the two implementations' behaviour
 * matter, so this one uses the same `createClient()` factory Pro's does rather
 * than constructing `IxClient` directly.
 */
export function registerPatchesCommand(program: Command): void {
  program
    .command("patches")
    .description("List recent patches")
    .option("--limit <n>", "Maximum patches to return", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .action(async (opts: { limit: string; format: string }) => {
      const client = await createClient();
      const patches = await client.listPatches({ limit: parseInt(opts.limit, 10) });
      formatPatches(patches, opts.format);
    });
}
