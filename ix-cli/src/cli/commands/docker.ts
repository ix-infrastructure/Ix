// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { execFileSync, spawn } from "child_process";
import { createInterface } from "readline";
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { stampBackendVersionAfterPull } from "./upgrade.js";

const IX_HOME = process.env.IX_HOME || join(homedir(), ".ix");
const COMPOSE_DIR = join(IX_HOME, "backend");
const LOCAL_COMPOSE = join(COMPOSE_DIR, "docker-compose.yml");
const HEALTH_URL = "http://localhost:8090/v1/health";
const ARANGO_URL = "http://localhost:8529/_api/version";

/**
 * The compose file this CLI release ships. `npm run build` copies the repo's
 * docker-compose.standalone.yml to dist/, which the release tarball carries;
 * a source checkout also finds it at the repo root, four levels above this
 * file. Both are located from the CLI's own install, never from the cwd.
 */
function bundledComposeFile(): string | null {
  if (process.env.NODE_ENV === "test" && process.env.IX_BUNDLED_COMPOSE !== undefined) {
    return process.env.IX_BUNDLED_COMPOSE && existsSync(process.env.IX_BUNDLED_COMPOSE)
      ? process.env.IX_BUNDLED_COMPOSE
      : null;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "..", "docker-compose.standalone.yml"),
    join(here, "..", "..", "..", "..", "docker-compose.standalone.yml"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The backend's compose file, ~/.ix/backend/docker-compose.yml, written from
 * the copy this CLI ships when it is missing. Never a docker-compose.yml from
 * the working directory: `ix docker start` inside an untrusted repository
 * would otherwise run whatever services that repository's compose file
 * declares. And never a download from the `main` branch, which may not match
 * the installed CLI.
 */
function findComposeFile(): string | null {
  if (existsSync(LOCAL_COMPOSE)) return LOCAL_COMPOSE;
  const bundled = bundledComposeFile();
  if (!bundled) return null;
  try {
    mkdirSync(COMPOSE_DIR, { recursive: true });
    copyFileSync(bundled, LOCAL_COMPOSE);
    return LOCAL_COMPOSE;
  } catch {
    return null;
  }
}

function reportMissingCompose(): void {
  console.error(`[error] No backend compose file at ${LOCAL_COMPOSE}, and this CLI install does not ship one.`);
  console.error("  Reinstall or run 'ix upgrade' to restore it.");
}

/** Compose projects whose volumes are Ix backend data: ix docker's own, and a repo checkout run directly. */
const IX_COMPOSE_PROJECTS = new Set(["backend", "ix"]);

/**
 * Is this volume an Ix backend's ArangoDB data? Exact compose project and
 * volume names. The previous test (project starting with "ix", volume
 * containing "arango") also matched other stacks' databases on the same
 * machine (ix-bench, a personal or test backend), which --remove-all-data
 * then deleted.
 */
export function isIxArangoVolume(labels: Map<string, string>): boolean {
  return (
    IX_COMPOSE_PROJECTS.has(labels.get("com.docker.compose.project") ?? "") &&
    labels.get("com.docker.compose.volume") === "arangodb-data"
  );
}

function findIxArangoVolumes(): string[] {
  try {
    const output = execFileSync(
      "docker",
      ["volume", "ls", "--format", "{{.Name}}|{{.Labels}}"],
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    if (!output) return [];

    return output.split("\n").filter((line) => {
      const [name, labels] = line.split("|", 2);
      if (!name || !labels) return false;

      const labelMap = new Map<string, string>();
      for (const pair of labels.split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) labelMap.set(pair.slice(0, eq), pair.slice(eq + 1));
      }

      return isIxArangoVolume(labelMap);
    }).map((line) => line.split("|", 1)[0]);
  } catch {
    return [];
  }
}

function askConfirmation(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

function isHealthy(): boolean {
  try {
    execFileSync("curl", ["-sf", HEALTH_URL], { stdio: "ignore", timeout: 5000 });
    execFileSync("curl", ["-sf", ARANGO_URL], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

export function registerDockerCommand(program: Command): void {
  const docker = program
    .command("docker")
    .description("Manage the IX backend Docker containers");

  docker
    .command("start")
    .alias("up")
    .description("Start the IX backend (ArangoDB + Memory Layer)")
    .action(async () => {
      // Written before anything else, so stop/restart/logs work from any directory.
      const composeFile = findComposeFile();

      if (isHealthy()) {
        console.log("[ok] Backend is already running and healthy");
        console.log("  Memory Layer: http://localhost:8090");
        console.log("  ArangoDB:     http://localhost:8529");
        return;
      }

      if (!dockerAvailable()) {
        console.error("[error] Docker is not running.");
        console.error("  Start Docker Desktop and try again.");
        process.exit(1);
      }

      if (!composeFile) {
        reportMissingCompose();
        process.exit(1);
      }

      console.log("Starting backend services...");
      try {
        execFileSync("docker", ["compose", "-f", composeFile, "up", "-d", "--pull", "always"], {
          stdio: "inherit",
        });
      } catch {
        console.error("[error] Failed to start Docker containers.");
        process.exit(1);
      }

      // `--pull always` just fetched the images this compose names, so if it
      // tracks `:latest` the container is now running the current backend
      // release — record it. Without this the tracked version only ever moves
      // when `ix upgrade` runs, so starting the backend any other way leaves a
      // file naming an older release and the update notice fires on every
      // command for ever. The compose file is passed because it decides whether
      // that premise holds at all: a user may have edited it to pin a tag, a
      // digest, or a local build.
      // Awaited so the stamp is on disk before the command returns, and it
      // cannot fail the start: the helper swallows its own errors.
      await stampBackendVersionAfterPull(composeFile);

      console.log("Waiting for services to become healthy...");
      for (let i = 0; i < 30; i++) {
        if (isHealthy()) {
          console.log("");
          console.log("[ok] Backend is ready!");
          console.log("  Memory Layer: http://localhost:8090");
          console.log("  ArangoDB:     http://localhost:8529");
          return;
        }
        process.stdout.write(".");
        await new Promise((r) => setTimeout(r, 2000));
      }

      console.log("");
      console.error("[!!] Health check timed out. Check: ix docker logs");
      process.exit(1);
    });

  docker
    .command("stop")
    .alias("down")
    .description("Stop the IX backend containers")
    .option("--remove-data", "Also remove the current project's ArangoDB data volume")
    .option("--remove-all-data", "Remove all local Ix ArangoDB data volumes across repos")
    .option("--yes", "Skip confirmation prompt (for use with --remove-all-data)")
    .action(async (opts) => {
      const composeFile = findComposeFile();
      if (!composeFile) {
        reportMissingCompose();
        process.exit(1);
      }

      const removeLocal = opts.removeData || opts.removeAllData;
      const args = ["compose", "-f", composeFile, "down"];
      if (removeLocal) args.push("-v");

      try {
        execFileSync("docker", args, { stdio: "inherit" });
      } catch {
        console.error("[error] Failed to stop containers.");
        process.exit(1);
      }

      if (opts.removeAllData) {
        const volumes = findIxArangoVolumes();
        if (volumes.length === 0) {
          console.log("[ok] Backend stopped. No additional Ix data volumes found.");
          return;
        }

        if (!opts.yes) {
          console.log("");
          console.log("This will remove all local Ix ArangoDB data volumes across repos:");
          for (const v of volumes) console.log(`  ${v}`);
          console.log("");
          const confirmed = await askConfirmation("Continue? [y/N] ");
          if (!confirmed) {
            console.log("Aborted.");
            return;
          }
        }

        const removed: string[] = [];
        const failed: string[] = [];
        for (const v of volumes) {
          try {
            execFileSync("docker", ["volume", "rm", v], { stdio: "ignore", timeout: 10000 });
            removed.push(v);
          } catch {
            failed.push(v);
          }
        }

        if (failed.length > 0) {
          console.error("");
          console.error("[error] Failed to remove one or more Ix data volumes.");
          for (const v of failed) console.error(`  ${v}`);
          console.error("");
          console.error("  Volumes may be in use. Stop all Ix containers first.");
          process.exitCode = 1;
        }

        if (removed.length > 0) {
          console.log("");
          console.log("[ok] Backend stopped and all local Ix data volumes removed.");
          console.log("");
          console.log("Removed:");
          for (const v of removed) console.log(`  ${v}`);
        }
      } else if (opts.removeData) {
        console.log("[ok] Backend stopped and data volume removed.");
      } else {
        console.log("[ok] Backend stopped. Data volume preserved.");
        console.log("  Use 'ix docker stop --remove-data' to also delete data.");
      }
    });

  docker
    .command("status")
    .description("Show backend container and health status")
    .action(() => {
      const composeFile = findComposeFile();
      if (composeFile) {
        try {
          execFileSync("docker", ["compose", "-f", composeFile, "ps"], {
            stdio: "inherit",
          });
        } catch {
          // compose ps failed, that's ok
        }
      }
      console.log("");
      if (isHealthy()) {
        console.log("[ok] Backend is healthy");
        console.log("  Memory Layer: http://localhost:8090");
        console.log("  ArangoDB:     http://localhost:8529");
      } else {
        console.log("[!!] Backend is not healthy");
        try {
          execFileSync("curl", ["-sf", HEALTH_URL], { stdio: "ignore", timeout: 3000 });
          console.log("  Memory Layer: responding");
        } catch {
          console.log("  Memory Layer: not responding");
        }
        try {
          execFileSync("curl", ["-sf", ARANGO_URL], { stdio: "ignore", timeout: 3000 });
          console.log("  ArangoDB: responding");
        } catch {
          console.log("  ArangoDB: not responding");
        }
      }
    });

  docker
    .command("logs")
    .description("Tail backend container logs")
    .option("-f, --follow", "Follow log output", true)
    .action((opts) => {
      const composeFile = findComposeFile();
      if (!composeFile) {
        reportMissingCompose();
        process.exit(1);
      }

      const args = ["compose", "-f", composeFile, "logs"];
      if (opts.follow) args.push("-f");
      const child = spawn("docker", args, { stdio: "inherit" });
      child.on("exit", (code) => process.exit(code || 0));
    });

  docker
    .command("restart")
    .description("Restart the IX backend containers")
    .action(() => {
      const composeFile = findComposeFile();
      if (!composeFile) {
        reportMissingCompose();
        process.exit(1);
      }

      try {
        execFileSync("docker", ["compose", "-f", composeFile, "restart"], {
          stdio: "inherit",
        });
        console.log("[ok] Backend restarted.");
      } catch {
        console.error("[error] Failed to restart containers.");
        process.exit(1);
      }
    });
}
