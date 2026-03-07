#!/usr/bin/env node
import { Command } from "commander";
import { registerQueryCommand } from "./commands/query.js";
import { registerIngestCommand } from "./commands/ingest.js";
import { registerDecideCommand } from "./commands/decide.js";
import { registerDecisionsCommand } from "./commands/decisions.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerTruthCommand } from "./commands/truth.js";
import { registerPatchesCommand } from "./commands/patches.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerEntityCommand } from "./commands/entity.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerConflictsCommand } from "./commands/conflicts.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerInitCommand } from "./commands/init.js";
import { registerMcpInstallCommand } from "./commands/mcp-install.js";
import { registerTextCommand } from "./commands/text.js";
import { registerLocateCommand } from "./commands/locate.js";
import { registerExplainCommand } from "./commands/explain.js";
import { registerCallersCommand } from "./commands/callers.js";

const program = new Command();
program
  .name("ix")
  .description("Ix Memory — Persistent Memory for LLM Systems")
  .version("0.1.0");

registerQueryCommand(program);
registerIngestCommand(program);
registerDecideCommand(program);
registerDecisionsCommand(program);
registerSearchCommand(program);
registerTruthCommand(program);
registerPatchesCommand(program);
registerStatusCommand(program);
registerEntityCommand(program);
registerHistoryCommand(program);
registerConflictsCommand(program);
registerDiffCommand(program);
registerInitCommand(program);
registerMcpInstallCommand(program);
registerTextCommand(program);
registerLocateCommand(program);
registerExplainCommand(program);
registerCallersCommand(program);

program
  .command("mcp-start")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    await import("../mcp/server.js");
  });

program.parse();
