import type { Command } from "commander";
import chalk from "chalk";

import { llmLine, type LlmValue } from "../llm.js";
import type { DoctorReport, HostReport, InstallReport, Outcome } from "../../mcp/install.js";

/** Symbol and colour per outcome, shared by install and doctor. */
const OUTCOME_STYLE: Record<Outcome, { mark: string; paint: (text: string) => string }> = {
  registered: { mark: "+", paint: chalk.green },
  "would-register": { mark: "+", paint: chalk.cyan },
  "already-registered": { mark: "=", paint: chalk.dim },
  conflict: { mark: "!", paint: chalk.yellow },
  failed: { mark: "x", paint: chalk.red },
  "not-registered": { mark: "o", paint: chalk.yellow },
  "not-installed": { mark: "-", paint: chalk.dim },
};

const OUTCOME_TEXT: Record<Outcome, string> = {
  registered: "registered",
  "would-register": "would register",
  "already-registered": "already registered",
  conflict: "conflict — left alone",
  failed: "failed",
  "not-registered": "not registered",
  "not-installed": "not installed",
};

function renderHostLine(host: HostReport): string {
  const style = OUTCOME_STYLE[host.outcome];
  const label = host.label.padEnd(13);
  const line = `  ${style.mark} ${label} ${OUTCOME_TEXT[host.outcome]}`;
  return style.paint(line) + (host.note ? chalk.dim(`\n      ${host.note}`) : "");
}

function hostFields(host: HostReport): Array<[string, LlmValue]> {
  return [
    ["host", host.id],
    ["outcome", host.outcome],
    ["installed", host.installed],
    ["registration", host.registration],
    ["note", host.note],
  ];
}

function renderInstall(report: InstallReport, format: string, dryRun: boolean): void {
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (format === "llm") {
    for (const host of report.hosts) console.log(llmLine("host", hostFields(host)));
    console.log(llmLine("summary", [["registered", report.registered], ["conflicts", report.conflicts]]));
    return;
  }

  console.log(chalk.bold(dryRun ? "\nix mcp install --dry-run" : "\nix mcp install"));
  for (const host of report.hosts) console.log(renderHostLine(host));

  const conflicts = report.hosts.filter((host) => host.outcome === "conflict");
  if (conflicts.length > 0) {
    console.log(
      chalk.dim(
        `\n  ${conflicts.length} host(s) already use the name '${chalk.bold("ix-memory")}' for a different server.` +
          `\n  Nothing was changed there. Re-run with --force to replace them.`,
      ),
    );
  }
  console.log();
}

function renderDoctor(report: DoctorReport, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (format === "llm") {
    console.log(llmLine("server", [["ix_on_path", report.ixOnPath], ["tools", report.toolCount]]));
    for (const host of report.hosts) console.log(llmLine("host", hostFields(host)));
    return;
  }

  console.log(chalk.bold("\nix mcp doctor"));
  console.log(
    report.ixOnPath
      ? chalk.green(`  + ix on PATH`) + chalk.dim(`  (hosts launch the bare command \`ix\`)`)
      : chalk.red(`  x ix is NOT on PATH`) +
          chalk.dim(`\n      Every registration launches \`ix mcp\` and will fail until it resolves.`),
  );
  console.log(chalk.dim(`  ${report.toolCount} tools advertised`));
  console.log();
  for (const host of report.hosts) console.log(renderHostLine(host));
  console.log();
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Serve Ix tools over the Model Context Protocol (stdio)")
    .action(async () => {
      // Keep the SDK off the startup path for ordinary CLI commands.
      const { startIxMcpServer } = await import("../../mcp/server.js");
      await startIxMcpServer(program.version());
    });

  mcp
    .command("install")
    .description("Register `ix mcp` with the AI clients installed on this machine")
    .option("--host <ids...>", "Only these hosts (claude, codex, cursor, vscode, gemini, openclaw, opencode)")
    .option("--dry-run", "Report what would change without writing anything", false)
    .option("--force", "Replace a registration held by a different server", false)
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .action(async (opts: { host?: string[]; dryRun: boolean; force: boolean; format: string }) => {
      const { runInstall } = await import("../../mcp/install.js");
      const report = await runInstall({ only: opts.host, dryRun: opts.dryRun, force: opts.force });
      renderInstall(report, opts.format, opts.dryRun);
      if (report.hosts.some((host) => host.outcome === "failed")) process.exitCode = 1;
    });

  mcp
    .command("doctor")
    .description("Check that `ix mcp` is registered and launchable from each client")
    .option("--host <ids...>", "Only these hosts")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .action(async (opts: { host?: string[]; format: string }) => {
      const { runDoctor } = await import("../../mcp/install.js");
      const report = await runDoctor({ only: opts.host });
      renderDoctor(report, opts.format);
      const broken = report.hosts.some((host) => host.outcome === "conflict" || host.outcome === "not-registered");
      if (!report.ixOnPath || broken) process.exitCode = 1;
    });
}
