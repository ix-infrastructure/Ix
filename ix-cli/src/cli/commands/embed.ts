/**
 * `ix embed` — Embedding management commands.
 *
 * Subcommands:
 *   --backfill    Compute embeddings for existing nodes that lack them.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { getEndpoint, getAuthToken, refreshAuthIfNeeded } from "../config.js";

interface EmbedOptions {
  backfill: boolean;
  batchSize: string;
  kind?: string;
  format: string;
  loop: boolean;
}

export function registerEmbedCommand(program: Command): void {
  program
    .command("embed")
    .description("Manage node embeddings")
    .option("--backfill", "Compute embeddings for nodes that lack them", false)
    .option("--batch-size <n>", "Nodes per batch", "200")
    .option("--kind <kind>", "Only backfill nodes of this kind")
    .option("--loop", "Repeat until all nodes are embedded", false)
    .option("--format <format>", "Output format (text or json)", "text")
    .addHelpText("after", `
Examples:
  ix embed --backfill
  ix embed --backfill --kind concept --batch-size 500
  ix embed --backfill --loop`)
    .action(async (opts: EmbedOptions) => {
      await refreshAuthIfNeeded();
      if (!opts.backfill) {
        console.error(chalk.yellow("Usage: ix embed --backfill [--kind <kind>] [--batch-size <n>] [--loop]"));
        process.exitCode = 1;
        return;
      }

      try {
        await runBackfill(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.format === "json") {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(chalk.red(`Error: ${msg}`));
        }
        process.exitCode = 1;
      }
    });
}

async function runBackfill(opts: EmbedOptions): Promise<void> {
  const isJson = opts.format === "json";
  const batchSize = parseInt(opts.batchSize, 10) || 200;
  const endpoint = getEndpoint();
  const start = performance.now();

  let totalEmbedded = 0;
  let totalFailed = 0;
  let iteration = 0;

  if (!isJson) {
    process.stderr.write(
      chalk.dim("  Backfilling embeddings") +
      (opts.kind ? chalk.dim(` (kind: ${chalk.cyan(opts.kind)})`) : "") +
      chalk.dim(`  batch size: ${batchSize}\n`)
    );
  }

  do {
    iteration++;

    if (!isJson && iteration > 1) {
      process.stderr.write(chalk.dim(`  Pass ${iteration}...\n`));
    }

    const body: Record<string, unknown> = { batchSize };
    if (opts.kind) body.kind = opts.kind;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getAuthToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const resp = await fetch(`${endpoint}/v1/embed/backfill`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Backend error (${resp.status}): ${text}`);
    }

    const result = (await resp.json()) as {
      embedded: number;
      failed: number;
      remaining: number;
    };

    totalEmbedded += result.embedded;
    totalFailed += result.failed;

    if (!isJson) {
      process.stderr.write(
        chalk.dim("  ") +
        chalk.cyan(String(result.embedded)) +
        chalk.dim(" embedded") +
        (result.failed > 0 ? chalk.yellow(`, ${result.failed} failed`) : "") +
        (result.remaining > 0 ? chalk.dim(`, ${result.remaining} remaining`) : "") +
        "\n"
      );
    }

    // Stop if nothing was embedded (avoid infinite loop) or no remaining
    if (result.embedded === 0 || result.remaining === 0) break;

  } while (opts.loop);

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);

  if (isJson) {
    console.log(JSON.stringify({
      embedded: totalEmbedded,
      failed: totalFailed,
      iterations: iteration,
      elapsed: `${elapsed}s`,
    }));
  } else {
    console.log();
    console.log(chalk.bold("Backfill complete"));
    console.log(`  embedded:    ${chalk.cyan(String(totalEmbedded))}`);
    if (totalFailed > 0) console.log(`  failed:      ${chalk.yellow(String(totalFailed))}`);
    if (iteration > 1) console.log(`  iterations:  ${chalk.dim(String(iteration))}`);
    console.log(`  elapsed:     ${chalk.dim(elapsed + "s")}`);
  }
}
