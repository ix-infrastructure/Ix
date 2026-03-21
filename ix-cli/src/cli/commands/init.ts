import type { Command } from "commander";
import chalk from "chalk";
import { bootstrap } from "../bootstrap.js";

/** @deprecated Use `ix map .` — bootstrap is now automatic. */
export function registerInitCommand(program: Command): void {
  const cmd = program
    .command("init")
    .description("(deprecated) Initialize Ix — use ix map . instead")
    .action(async () => {
      try {
        await bootstrap();
        console.log(chalk.green("✓") + " Ix is ready. Run " + chalk.bold("ix map .") + " to get started.");
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
      }
    });

  // Hide from default help — no longer the recommended entrypoint
  (cmd as any).hidden = true;
}
