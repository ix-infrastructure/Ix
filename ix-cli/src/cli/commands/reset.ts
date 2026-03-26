import * as nodePath from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import type { Command } from "commander";
import chalk from "chalk";
import { spawnSync } from "child_process";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

function mtimeCachePath(projectRoot: string): string {
  const key = crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  return nodePath.join(os.homedir(), ".ix", `ingest_mtimes_${key}.json`);
}

function clearMtimeCache(projectRoot: string): void {
  try {
    fs.rmSync(mtimeCachePath(projectRoot), { force: true });
  } catch {
    // Non-critical
  }
}

export function registerResetCommand(program: Command): void {
  program
    .command("reset")
    .description("Wipe graph data")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--code", "Reset only code graph (files, functions, classes, regions); preserve goals, plans, tasks, bugs, and decisions")
    .option("--ingest", "Re-run ix map after wiping (rebuilds the code graph)")
    .action(async (opts: { yes?: boolean; code?: boolean; ingest?: boolean }) => {
      const scope = opts.code ? "code graph" : "all graph data";
      const warning = opts.code
        ? "This will delete all code nodes and edges (files, functions, classes, regions).\nPlanning artifacts (goals, plans, tasks, bugs, decisions) will be preserved."
        : "This will delete ALL nodes and edges including planning artifacts.";

      if (!opts.yes) {
        console.log(chalk.yellow(warning));
        process.stdout.write(chalk.yellow(`Reset ${scope}? (y/N) `));
        const answer = await new Promise<string>(resolve => {
          process.stdin.setEncoding("utf8");
          process.stdin.once("data", (chunk: string) => resolve(chunk.trim()));
        });
        process.stdin.destroy();
        if (answer.toLowerCase() !== "y") {
          console.log(chalk.dim("Aborted."));
          return;
        }
      }

      const client = new IxClient(getEndpoint());
      const label = opts.code ? "Wiping code graph..." : "Wiping graph...";
      const spinnerFrames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
      let spinIdx = 0;
      const interval = setInterval(() => {
        process.stderr.write(`\r${chalk.cyan(spinnerFrames[spinIdx++ % spinnerFrames.length])} ${chalk.dim(label)}`);
      }, 80);
      try {
        if (opts.code) {
          await client.resetCode();
          clearInterval(interval);
          process.stderr.write("\r\x1b[K");
          // Clear the mtime cache so the next ix map re-ingests all files
          clearMtimeCache(process.cwd());
          console.log(chalk.green("✓") + " Code graph wiped. Planning artifacts preserved.");
          console.log(chalk.dim("  Run `ix map` to rebuild the code graph."));
        } else {
          await client.reset();
          clearInterval(interval);
          process.stderr.write("\r\x1b[K");
          clearMtimeCache(process.cwd());
          console.log(chalk.green("✓") + " Graph wiped.");
        }
      } catch (err: any) {
        clearInterval(interval);
        process.stderr.write("\r\x1b[K");
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }

      if (opts.ingest) {
        console.log(chalk.dim("Rebuilding..."));
        const result = spawnSync(process.argv[0], [process.argv[1], "map"], {
          stdio: "inherit",
          cwd: process.cwd(),
        });
        if (result.status !== 0) process.exitCode = result.status ?? 1;
      }
    });
}
