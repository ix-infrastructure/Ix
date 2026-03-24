import { Command } from "commander";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import chalk from "chalk";

const GITHUB_ORG = "ix-infrastructure";
const GITHUB_REPO = "Ix";
const IX_HOME = process.env.IX_HOME || join(homedir(), ".ix");
const VERSION_CACHE = join(IX_HOME, ".version-check.json");

interface VersionCache {
  latest: string;
  checkedAt: number;
}

function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "../../../package.json"), "utf-8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest`
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { tag_name?: string };
    return data.tag_name?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
}

function readCache(): VersionCache | null {
  try {
    if (!existsSync(VERSION_CACHE)) return null;
    return JSON.parse(readFileSync(VERSION_CACHE, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    mkdirSync(IX_HOME, { recursive: true });
    writeFileSync(
      VERSION_CACHE,
      JSON.stringify({ latest, checkedAt: Date.now() })
    );
  } catch {
    // non-critical
  }
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

function detectPlatform(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `${os}-${arch}`;
}

/**
 * Check for updates (non-blocking, cached for 1 hour).
 * Call this from other commands to notify users.
 */
export async function checkForUpdate(): Promise<void> {
  const current = getCurrentVersion();
  const cache = readCache();

  if (cache && Date.now() - cache.checkedAt < 3600_000) {
    if (isNewer(cache.latest, current)) {
      printUpdateNotice(current, cache.latest);
    }
    return;
  }

  fetchLatestVersion().then((latest) => {
    if (!latest) return;
    writeCache(latest);
    if (isNewer(latest, current)) {
      printUpdateNotice(current, latest);
    }
  });
}

function printUpdateNotice(current: string, latest: string): void {
  console.error("");
  console.error(
    chalk.yellow(`  Update available: ${current} → ${latest}`)
  );
  console.error(chalk.dim("  Run: ix upgrade"));
  console.error("");
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade ix CLI and backend to the latest version")
    .option("--check", "Only check for updates, don't install")
    .action(async (opts: { check?: boolean }) => {
      const current = getCurrentVersion();
      console.log(`Current version: ${current}`);
      console.log("Checking for updates...");

      const latest = await fetchLatestVersion();
      if (!latest) {
        console.error("[error] Could not reach GitHub to check for updates.");
        process.exit(1);
      }

      writeCache(latest);

      if (!isNewer(latest, current)) {
        console.log(`[ok] Already on the latest version (${current})`);
        return;
      }

      console.log(`New version available: ${chalk.green(latest)}`);

      if (opts.check) return;

      const platform = detectPlatform();
      const tarball = `ix-${latest}-${platform}.tar.gz`;
      const url = `https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/releases/download/v${latest}/${tarball}`;
      const installDir = join(IX_HOME, "cli");

      // Use secure temp directory
      const tmpDir = mkdtempSync(join(tmpdir(), "ix-upgrade-"));
      const tmpFile = join(tmpDir, tarball);

      console.log(`Downloading ix ${latest} for ${platform}...`);

      try {
        execFileSync(
          "curl",
          ["-fsSL", url, "-o", tmpFile],
          { stdio: "inherit", timeout: 60000 }
        );
      } catch {
        console.error(`[error] Failed to download ${url}`);
        console.error("  You can also upgrade manually:");
        console.error(
          `  curl -fsSL https://raw.githubusercontent.com/${GITHUB_ORG}/${GITHUB_REPO}/main/install.sh | bash`
        );
        rmSync(tmpDir, { recursive: true, force: true });
        process.exit(1);
      }

      console.log("Installing...");
      try {
        rmSync(installDir, { recursive: true, force: true });
        mkdirSync(installDir, { recursive: true });
        execFileSync(
          "tar",
          ["-xzf", tmpFile, "-C", installDir, "--strip-components=1"],
          { stdio: "ignore" }
        );
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        console.error("[error] Failed to extract CLI update.");
        rmSync(tmpDir, { recursive: true, force: true });
        process.exit(1);
      }

      console.log(`[ok] Upgraded ix: ${current} → ${latest}`);

      console.log("Pulling latest backend image...");
      try {
        execFileSync(
          "docker",
          ["pull", "ghcr.io/ix-infrastructure/ix-memory-layer:latest"],
          { stdio: "inherit", timeout: 120000 }
        );
        console.log("[ok] Backend image updated");
      } catch {
        console.error("[!!] Could not pull latest backend image. Run: ix docker restart");
      }

      // Restart backend if running
      try {
        execFileSync("curl", ["-sf", "http://localhost:8090/v1/health"], {
          stdio: "ignore",
          timeout: 3000,
        });
        console.log("Restarting backend...");
        const composeFile = join(IX_HOME, "backend", "docker-compose.yml");
        if (existsSync(composeFile)) {
          execFileSync(
            "docker",
            ["compose", "-f", composeFile, "up", "-d", "--pull", "always"],
            { stdio: "inherit" }
          );
          console.log("[ok] Backend restarted with latest image");
        }
      } catch {
        // Backend not running, that's fine
      }

      console.log("");
      console.log(`[ok] ix ${latest} is ready`);
    });
}
