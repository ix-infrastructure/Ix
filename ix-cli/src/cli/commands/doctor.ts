import type { Command } from "commander";
import chalk from "chalk";
import { renderSection, renderSuccess, renderError } from "../ui.js";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { llmLine, printLlmLines } from "../llm.js";
import { existsSync, readFileSync } from "node:fs";
import { join as pathJoin, win32 as winPath } from "node:path";
import { homedir } from "node:os";
import {
  BACKEND_IMAGE,
  checkBackendImage,
  checkBackendSchema,
  isNonStandardBackend,
} from "../backend-status.js";
import { backendCeiling, isNewer, readBackendHealth } from "./upgrade.js";

interface CheckResult {
  ok: boolean;
  detail: string;
  // A warning is surfaced (yellow) but does not fail the overall run — e.g. an
  // intentional local dev backend, or an inconclusive image comparison.
  warn?: boolean;
}

/**
 * `ix doctor --format llm`.
 *
 * `text` renders a ✓/!/✗ glyph per check and then, on failure, the singularly
 * unhelpful "Run with --format json for details" — the details were already in
 * hand, they were just not printed. Every check's status and detail is emitted
 * here, so an agent never has to make a second call to find out what broke.
 *
 * Status is a word rather than a symbol because `ok`/`warn`/`fail` survives
 * being read back by something that is not a terminal.
 */
export function renderDoctorLlm(
  results: Array<{ name: string } & CheckResult>,
  hasFailure: boolean,
  hasWarning: boolean,
): string[] {
  const lines = [llmLine("doctor", [
    ["healthy", hasFailure ? "false" : "true"],
    ["warnings", hasWarning ? "true" : "false"],
    ["checks", String(results.length)],
  ])];
  for (const r of results) {
    lines.push(llmLine("check", [
      ["name", r.name],
      // Same precedence as the glyphs and as `hasFailure` below: a warning is
      // `{ ok: false, warn: true }`, so `warn` has to be checked on the
      // not-ok branch. Testing it on the ok branch reports every warning as a
      // hard failure, which is the opposite of what `hasFailure` concludes.
      ["status", r.ok ? "ok" : r.warn ? "warn" : "fail"],
      ["detail", r.detail],
    ]));
  }
  return lines;
}

interface Check {
  name: string;
  run: () => Promise<CheckResult>;
}

/**
 * Does `%IX_HOME%\bin\ix.cmd` still point at a CLI that exists?
 *
 * `ix upgrade` before 0.9.0 refreshed only the bash shim and left this launcher
 * aimed at a `cli\ix.cmd` the upgrade had just replaced with a version-nested
 * directory (Ix#385).
 *
 * The obvious objection is that a user whose launcher is broken cannot run
 * `ix doctor` to be told so. True from PowerShell — which is why the launcher
 * now diagnoses itself. This check covers the case that shim cannot: the *bash*
 * shim under Git Bash / MSYS is refreshed by every version, so `ix` keeps
 * working there while the native launcher is quietly dead. Someone who lives in
 * Git Bash can be broken in PowerShell for weeks without knowing.
 */
export function checkWindowsLauncher(
  ixHome: string,
  readShim: (path: string) => string | null,
  exists: (path: string) => boolean,
): CheckResult {
  const shimPath = pathJoin(ixHome, "bin", "ix.cmd");
  const body = readShim(shimPath);
  if (body === null) {
    return { ok: true, detail: "no ix.cmd launcher (not installed by install.ps1)" };
  }

  // The launcher invokes its target as the first quoted %~dp0-relative path.
  const target = body.match(/"(%~dp0[^"]+)"/)?.[1];
  if (!target) {
    return { ok: true, warn: true, detail: `${shimPath}: unrecognized launcher, left alone` };
  }

  // %~dp0 is the directory of ix.cmd itself — IX_HOME\bin — and the target is
  // written with backslashes. Resolve with win32 semantics explicitly rather
  // than the ambient `path`, so the separator handling does not depend on which
  // OS happens to be evaluating it. (Production only reaches here on Windows,
  // but a resolver that silently misreads its input off-Windows is untestable.)
  const resolved = winPath.join(ixHome, "bin", target.replace(/^%~dp0/, ""));
  if (exists(resolved)) return { ok: true, detail: `ix.cmd → ${target}` };

  return {
    ok: false,
    detail:
      `${shimPath} points at ${target}, which does not exist — ` +
      "an upgrade from before 0.9.0 moved the CLI. Reinstall to repair: " +
      "irm https://ix-infra.com/install.ps1 | iex",
  };
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
              // Records what the backend says it is running; see
               // backend-version.ts. Free — this response is already needed.
              const h = await readBackendHealth(client);
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
            const s = await checkBackendSchema(client, backendCeiling(), isNewer);
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

      // Windows-only: a launcher pointing at a CLI the upgrade moved (Ix#385).
      if (process.platform === "win32") {
        checks.push({
          name: "Windows launcher",
          run: async () =>
            checkWindowsLauncher(
              process.env.IX_HOME || pathJoin(homedir(), ".ix"),
              (p) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
              existsSync,
            ),
        });
      }

      const results: Array<{ name: string } & CheckResult> = [];
      for (const check of checks) {
        const result = await check.run();
        results.push({ name: check.name, ...result });
      }

      const hasFailure = results.some((r) => !r.ok && !r.warn);
      const hasWarning = results.some((r) => r.warn);

      if (opts.format === "llm") {
        printLlmLines(renderDoctorLlm(results, hasFailure, hasWarning));
        return;
      }

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
