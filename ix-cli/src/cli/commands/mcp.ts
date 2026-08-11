import type { Command } from "commander";

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Serve Ix tools over the Model Context Protocol (stdio)")
    .action(async () => {
      // Keep the SDK off the startup path for ordinary CLI commands.
      const { startIxMcpServer } = await import("../../mcp/server.js");
      await startIxMcpServer(program.version());
    });
}
