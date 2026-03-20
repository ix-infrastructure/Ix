import { Command } from "commander";
import { execSync, spawn } from "child_process";
import { createInterface } from "readline";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const IX_HOME = process.env.IX_HOME || join(homedir(), ".ix");
const COMPOSE_DIR = join(IX_HOME, "backend");
const LOCAL_COMPOSE = join(COMPOSE_DIR, "docker-compose.yml");
const HEALTH_URL = "http://localhost:8090/v1/health";
const ARANGO_URL = "http://localhost:8529/_api/version";
const GITHUB_RAW =
  "https://raw.githubusercontent.com/ix-infrastructure/Ix/main";

function findComposeFile(): string | null {
  // Check standalone install location first
  if (existsSync(LOCAL_COMPOSE)) return LOCAL_COMPOSE;

  // Check if we're in the Ix repo
  const repoCompose = join(process.cwd(), "docker-compose.yml");
  if (existsSync(repoCompose)) return repoCompose;

  return null;
}

/**
 * Find all Ix-managed ArangoDB Docker volumes across repos.
 *
 * Matches volumes created by Docker Compose where:
 *   - The compose project name starts with "ix" (label: com.docker.compose.project)
 *   - The compose volume name contains "arango" (label: com.docker.compose.volume)
 *
 * This avoids matching unrelated ArangoDB volumes (e.g. enterprise projects).
 */
function findIxArangoVolumes(): string[] {
  try {
    const output = execSync(
      'docker volume ls --format "{{.Name}}|{{.Labels}}"',
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    if (!output) return [];

    return output.split("\n").filter((line) => {
      const [name, labels] = line.split("|", 2);
      if (!name || !labels) return false;

      // Parse labels: "key1=val1,key2=val2,..."
      const labelMap = new Map<string, string>();
      for (const pair of labels.split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) labelMap.set(pair.slice(0, eq), pair.slice(eq + 1));
      }

      const project = labelMap.get("com.docker.compose.project") ?? "";
      const volume = labelMap.get("com.docker.compose.volume") ?? "";

      // Match: Ix project (starts with "ix") + ArangoDB volume (contains "arango")
      return project.startsWith("ix") && volume.includes("arango");
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
    execSync(`curl -sf ${HEALTH_URL}`, { stdio: "ignore", timeout: 5000 });
    execSync(`curl -sf ${ARANGO_URL}`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 10000 });
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

      let composeFile = findComposeFile();

      // If no compose file found, download the standalone one
      if (!composeFile) {
        console.log("Downloading docker-compose.yml...");
        try {
          execSync(`mkdir -p "${COMPOSE_DIR}"`);
          execSync(
            `curl -fsSL "${GITHUB_RAW}/docker-compose.standalone.yml" -o "${LOCAL_COMPOSE}"`,
            { stdio: "inherit" }
          );
          composeFile = LOCAL_COMPOSE;
          console.log(`[ok] Saved to ${COMPOSE_DIR}`);
        } catch {
          console.error(
            "[error] Failed to download docker-compose.yml"
          );
          process.exit(1);
        }
      }

      console.log("Starting backend services...");
      try {
        execSync(`docker compose -f "${composeFile}" up -d`, {
          stdio: "inherit",
        });
      } catch {
        console.error("[error] Failed to start Docker containers.");
        process.exit(1);
      }

      // Wait for health
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
      console.error(
        "[!!] Health check timed out. Check: ix docker logs"
      );
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
        console.error("[error] No docker-compose.yml found.");
        console.error(
          "  Run 'ix docker start' first, or run from the Ix repo."
        );
        process.exit(1);
      }

      // --remove-all-data is a superset of --remove-data
      const removeLocal = opts.removeData || opts.removeAllData;
      const flags = removeLocal ? "down -v" : "down";

      try {
        execSync(`docker compose -f "${composeFile}" ${flags}`, {
          stdio: "inherit",
        });
      } catch {
        console.error("[error] Failed to stop containers.");
        process.exit(1);
      }

      if (opts.removeAllData) {
        // Global cleanup: find and remove all Ix ArangoDB volumes
        const volumes = findIxArangoVolumes();
        if (volumes.length === 0) {
          console.log("[ok] Backend stopped. No additional Ix data volumes found.");
          return;
        }

        // Confirm unless --yes
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
            execSync(`docker volume rm "${v}"`, { stdio: "ignore", timeout: 10000 });
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
        console.log(
          "  Use 'ix docker stop --remove-data' to also delete data."
        );
      }
    });

  docker
    .command("status")
    .description("Show backend container and health status")
    .action(() => {
      const composeFile = findComposeFile();
      if (composeFile) {
        try {
          execSync(`docker compose -f "${composeFile}" ps`, {
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
          execSync(`curl -sf ${HEALTH_URL}`, {
            stdio: "ignore",
            timeout: 3000,
          });
          console.log("  Memory Layer: responding");
        } catch {
          console.log("  Memory Layer: not responding");
        }
        try {
          execSync(`curl -sf ${ARANGO_URL}`, {
            stdio: "ignore",
            timeout: 3000,
          });
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
        console.error("[error] No docker-compose.yml found.");
        process.exit(1);
      }

      const followFlag = opts.follow ? "-f" : "";
      const child = spawn(
        "docker",
        ["compose", "-f", composeFile, "logs", followFlag].filter(Boolean),
        { stdio: "inherit" }
      );
      child.on("exit", (code) => process.exit(code || 0));
    });

  docker
    .command("restart")
    .description("Restart the IX backend containers")
    .action(() => {
      const composeFile = findComposeFile();
      if (!composeFile) {
        console.error("[error] No docker-compose.yml found.");
        process.exit(1);
      }

      try {
        execSync(`docker compose -f "${composeFile}" restart`, {
          stdio: "inherit",
        });
        console.log("[ok] Backend restarted.");
      } catch {
        console.error("[error] Failed to restart containers.");
        process.exit(1);
      }
    });
}
