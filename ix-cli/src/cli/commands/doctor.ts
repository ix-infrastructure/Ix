import type { Command } from "commander";
import chalk from "chalk";
import { renderSection, renderSuccess, renderError } from "../ui.js";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import {
  BACKEND_IMAGE,
  checkBackendImage,
  checkBackendSchema,
  isNonStandardBackend,
} from "../backend-status.js";

interface CheckResult {
  ok: boolean;
  detail: string;
  // A warning is surfaced (yellow) but does not fail the overall run — e.g. an
  // intentional local dev backend, or an inconclusive image comparison.
  warn?: boolean;
}

interface Check {
  name: string;
  run: () => Promise<CheckResult>;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check Ix system health — server, database, graph integrity")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
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
        {
          // Ix#270: trust the running container, not the version stamp.
          name: "Backend is the released image",
          run: async () => {
            const status = checkBackendImage();
            switch (status.kind) {
              case "ok": {
                if (isNonStandardBackend(status.container)) {
                  return {
                    ok: false, warn: true,
                    detail: `released image, but via a non-standard compose project (${status.container.composeProject ?? "unknown"})`,
                  };
                }
                return { ok: true, detail: "running the released image" };
              }
              case "local-build":
                return {
                  ok: false, warn: true,
                  detail: `running a local build (${status.container.imageRef}), not the released image — ` +
                    `'ix docker stop && ix docker start' pulls ${BACKEND_IMAGE}:latest`,
                };
              case "digest-mismatch":
                return {
                  ok: false, warn: true,
                  detail: "running an older image digest than :latest — " +
                    "'ix docker stop && ix docker start' pulls the released image",
                };
              case "latest-not-pulled":
                return { ok: true, warn: true, detail: `can't verify — ${BACKEND_IMAGE}:latest not pulled locally` };
              case "not-running":
                return { ok: true, detail: "no backend container on :8090 (skipped)" };
              case "docker-unavailable":
                return { ok: true, detail: "docker unavailable (skipped)" };
            }
          },
        },
        {
          // Ix#271: a graph written by an older engine fails scoped reads silently.
          name: "Graph schema matches engine",
          run: async () => {
            const s = await checkBackendSchema(client);
            if (!s.reachable) return { ok: true, detail: "backend unreachable (skipped)" };
            if (s.serverVersion === null) return { ok: true, detail: "backend does not report a schema version" };
            if (s.matches) return { ok: true, detail: `schema v${s.serverVersion}` };
            return {
              ok: false, warn: true,
              detail: `graph schema v${s.serverVersion}, this CLI expects v${s.expected} — ` +
                "re-map to rebuild the graph: 'ix map .'",
            };
          },
        },
      ];

      const results: Array<{ name: string } & CheckResult> = [];
      for (const check of checks) {
        const result = await check.run();
        results.push({ name: check.name, ...result });
      }

      const hasFailure = results.some((r) => !r.ok && !r.warn);
      const hasWarning = results.some((r) => r.warn);

      if (opts.format === "json") {
        console.log(JSON.stringify({ healthy: !hasFailure, hasWarnings: hasWarning, checks: results }, null, 2));
        return;
      }

      renderSection("Ix Doctor");
      console.log();
      for (const r of results) {
        const icon = r.ok ? chalk.green("✓") : r.warn ? chalk.yellow("!") : chalk.red("✗");
        const detail = chalk.dim(` — ${r.detail}`);
        console.log(`  ${icon} ${r.name}${detail}`);
      }

      console.log();
      if (hasFailure) {
        renderError("Some checks failed. Run with --format json for details.");
      } else if (hasWarning) {
        renderSuccess("All checks passed (with warnings).");
      } else {
        renderSuccess("All checks passed.");
      }
      console.log();
    });
}
