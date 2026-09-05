import type { Command } from "commander";
import chalk from "chalk";
import { spawnSync } from "child_process";
import { IxClient } from "../../client/api.js";
import { getEndpoint, clearIngestMtimeCache, clearStitchScopeCache } from "../config.js";
import { canRenderProgress } from "../stderr.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { clearStitchCooldown } from "../stitch-guard.js";

/**
 * Drop this workspace's cached "am I stitched into a system?" answer.
 *
 * A reset wipes the graph, so the stitch records go with it and any cached
 * system id is now a lie. Best-effort and silent: an unresolvable workspace
 * simply has nothing cached to clear.
 */
function clearStitchScopeCacheForCwd(): void {
  const ws = resolveWorkspaceId(process.cwd());
  if (ws) clearStitchScopeCache(ws);
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
      // This spinner ran unconditionally, so a redirected `ix reset` collected a
      // frame every 80 ms for as long as the wipe took.
      const spinner = canRenderProgress() ? setInterval(() => {
        process.stderr.write(`\r${chalk.cyan(spinnerFrames[spinIdx++ % spinnerFrames.length])} ${chalk.dim(label)}`);
      }, 80) : null;
      // One teardown for all three exits rather than the pair repeated at each.
      // Clearing an interval that was never started is harmless, but writing the
      // erase sequence is not: with no spinner to erase it just deposits literal
      // escape bytes in whatever captured the output.
      const stopSpinner = () => {
        if (!spinner) return;
        clearInterval(spinner);
        process.stderr.write("\r\x1b[K");
      };
      try {
        if (opts.code) {
          await client.resetCode();
          stopSpinner();
          // Clear the mtime cache so the next ix map re-ingests all files
          clearIngestMtimeCache(process.cwd());
          clearStitchScopeCacheForCwd();
          // Ix#568: and the stitch cooldown. The re-ingest below is the one
          // run that can re-register this workspace, and a live cooldown would
          // refuse exactly it -- leaving the workspace unregistered with
          // nothing to retry, since an incremental map never reaches the stitch
          // block.
          //
          // This IS a trade, not a free clear, and the trade is worth stating:
          // wiping the graph does not stop a runaway AQL join -- that is the
          // whole premise of #568, the query outlives everything -- so clearing
          // the marker here can put a second cross-workspace join onto one that
          // is still running. One extra join against a workspace that would
          // otherwise stay unregistered with no way back.
          clearStitchCooldown(getEndpoint());
          console.log(chalk.green("✓") + " Code graph wiped. Planning artifacts preserved.");
          console.log(chalk.dim("  Run `ix map` to rebuild the code graph."));
        } else {
          await client.reset();
          stopSpinner();
          clearIngestMtimeCache(process.cwd());
          clearStitchScopeCacheForCwd();
          // Ix#568: and the stitch cooldown. The re-ingest below is the one
          // run that can re-register this workspace, and a live cooldown would
          // refuse exactly it -- leaving the workspace unregistered with
          // nothing to retry, since an incremental map never reaches the stitch
          // block.
          //
          // This IS a trade, not a free clear, and the trade is worth stating:
          // wiping the graph does not stop a runaway AQL join -- that is the
          // whole premise of #568, the query outlives everything -- so clearing
          // the marker here can put a second cross-workspace join onto one that
          // is still running. One extra join against a workspace that would
          // otherwise stay unregistered with no way back.
          clearStitchCooldown(getEndpoint());
          console.log(chalk.green("✓") + " Graph wiped.");
        }
      } catch (err: any) {
        stopSpinner();
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
