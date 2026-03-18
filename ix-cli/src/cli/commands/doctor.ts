import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

interface Check {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose issues with the Ix system — server, database, integrity")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const endpoint = getEndpoint();
      const client = new IxClient(endpoint);

      const checks: Check[] = [
        {
          name: "Server reachable",
          run: async () => {
            try {
              const h = await client.health();
              return { ok: h.status === "ok", detail: `${endpoint} → ${h.status}` };
            } catch (e: any) {
              return { ok: false, detail: e.message ?? "unreachable" };
            }
          },
        },
        {
          name: "Graph has nodes",
          run: async () => {
            try {
              const s = await client.stats();
              const total = s.nodes?.total ?? 0;
              return { ok: total > 0, detail: `${total} nodes` };
            } catch (e: any) {
              return { ok: false, detail: e.message ?? "stats failed" };
            }
          },
        },
        {
          name: "Graph has edges",
          run: async () => {
            try {
              const s = await client.stats();
              const total = s.edges?.total ?? 0;
              return { ok: total > 0, detail: `${total} edges` };
            } catch (e: any) {
              return { ok: false, detail: e.message ?? "stats failed" };
            }
          },
        },
        {
          name: "No unresolved conflicts",
          run: async () => {
            try {
              const c = await client.conflicts();
              const count = Array.isArray(c) ? c.length : 0;
              return { ok: count === 0, detail: count === 0 ? "clean" : `${count} conflict(s)` };
            } catch (e: any) {
              return { ok: false, detail: e.message ?? "conflicts check failed" };
            }
          },
        },
      ];

      const results: Array<{ name: string; ok: boolean; detail: string }> = [];
      for (const check of checks) {
        const result = await check.run();
        results.push({ name: check.name, ...result });
      }

      if (opts.format === "json") {
        const allOk = results.every((r) => r.ok);
        console.log(JSON.stringify({ healthy: allOk, checks: results }, null, 2));
        return;
      }

      console.log(chalk.bold("\nIx Doctor\n"));
      for (const r of results) {
        const icon = r.ok ? chalk.green("✓") : chalk.red("✗");
        const detail = chalk.dim(` — ${r.detail}`);
        console.log(`  ${icon} ${r.name}${detail}`);
      }

      const allOk = results.every((r) => r.ok);
      console.log();
      if (allOk) {
        console.log(chalk.green("All checks passed."));
      } else {
        console.log(chalk.red("Some checks failed. Run with --format json for details."));
      }
      console.log();
    });
}
