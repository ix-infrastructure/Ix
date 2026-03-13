import type { Command } from "commander";
import chalk from "chalk";
import { startServer, stopServer, isServerRunning, readPid, getServerVersion, getServerLogPath } from "../server-manager.js";

export function registerServerCommand(program: Command): void {
  const server = program
    .command("server")
    .description("Manage the Ix server process")
    .addHelpText("after", `
Subcommands:
  start    Start the server
  stop     Stop the server
  status   Show server status`);

  server.command("start")
    .description("Start the Ix server")
    .action(async () => {
      try {
        console.log("Starting Ix server...");
        const { pid } = await startServer();
        console.log(chalk.green(`Server started (PID: ${pid})`));
      } catch (err: any) {
        console.error(chalk.red(`Failed to start server: ${err.message}`));
        process.exit(1);
      }
    });

  server.command("stop")
    .description("Stop the Ix server")
    .action(async () => {
      if (!isServerRunning()) {
        console.log("Server is not running.");
        return;
      }
      console.log("Stopping Ix server...");
      await stopServer();
      console.log(chalk.green("Server stopped."));
    });

  server.command("status")
    .description("Show Ix server status")
    .action(async () => {
      const running = isServerRunning();
      const pid = readPid();
      if (!running) {
        console.log(chalk.yellow("Server is not running."));
        return;
      }
      console.log(chalk.green("Server is running"));
      console.log(`  PID: ${pid}`);
      console.log(`  Log: ${getServerLogPath()}`);
      const ver = await getServerVersion();
      if (ver) {
        console.log(`  Version: ${ver.version}`);
        console.log(`  Schema: ${ver.schemaVersion}`);
      }
    });
}
