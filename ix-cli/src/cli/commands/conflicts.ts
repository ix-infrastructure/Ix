// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { createClient } from "../../client/factory.js";
import { formatConflicts } from "../format.js";
import { formatOption } from "../options.js";

export function registerConflictsCommand(program: Command): void {
  program
    .command("conflicts")
    .description("List detected conflicts")
    .addOption(formatOption())
    .action(async (opts: { format: string }) => {
      const client = createClient();
      const conflicts = await client.conflicts();
      formatConflicts(conflicts as any[], opts.format);
    });
}
