import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, createWriteStream, readFileSync, rmSync, cpSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  readLocalManifest, writeLocalManifest, fetchRemoteManifest,
  fetchRemoteManifestForVersion, detectPlatform, getDownloadDir, getBackupDir,
  type LocalManifest,
} from "../manifest.js";
import { stopServer, startServer, healthCheck, isServerRunning, getServerJarPath } from "../server-manager.js";
import { getDataDir } from "../config.js";

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade Ix to the latest version")
    .option("--check", "Check for updates without installing")
    .option("--version <ver>", "Install specific version")
    .option("--channel <ch>", "Release channel", "stable")
    .option("--rollback", "Revert to previous version")
    .option("--reset", "Upgrade and wipe database")
    .action(async (opts) => {
      try {
        if (opts.rollback) {
          await doRollback();
        } else {
          await doUpgrade(opts);
        }
      } catch (err: any) {
        console.error(chalk.red(`Upgrade failed: ${err.message}`));
        process.exit(1);
      }
    });
}

async function doUpgrade(opts: { check?: boolean; version?: string; channel: string; reset?: boolean }) {
  // 1. Read local manifest
  const local = readLocalManifest();
  const currentVersion = local?.version ?? "unknown";
  const platform = detectPlatform();
  console.log(`Current version: ${chalk.cyan(currentVersion)} (${platform})`);

  // 2. Fetch remote manifest
  console.log("Checking for updates...");
  const remote = opts.version
    ? await fetchRemoteManifestForVersion(opts.version)
    : await fetchRemoteManifest(opts.channel);

  const newVersion = remote.version;

  // 3. Compare
  if (newVersion === currentVersion && !opts.reset) {
    console.log(chalk.green("Already up to date."));
    return;
  }

  // 4. Check mode
  const platformInfo = remote.platforms[platform];
  if (!platformInfo) {
    throw new Error(`No release available for platform: ${platform}`);
  }

  if (opts.check) {
    console.log(`\nAvailable: ${chalk.green(newVersion)} (current: ${chalk.cyan(currentVersion)})`);
    console.log(`  Channel: ${remote.channel}`);
    console.log(`  Schema: ${remote.schemaVersion}`);
    console.log(`  Released: ${remote.released}`);
    console.log(`\nRun ${chalk.bold("ix upgrade")} to install.`);
    return;
  }

  console.log(`\nUpgrading ${chalk.cyan(currentVersion)} → ${chalk.green(newVersion)}...`);

  // 5. Download
  const downloadDir = getDownloadDir();
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

  const archiveUrl = `https://github.com/ix-infrastructure/IX-Memory/releases/download/v${newVersion}/${platformInfo.archive}`;
  const archivePath = join(downloadDir, platformInfo.archive);

  console.log("Downloading...");
  const res = await fetch(archiveUrl);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
  const fileStream = createWriteStream(archivePath);
  await pipeline(Readable.fromWeb(res.body as any), fileStream);

  // 6. Verify SHA-256
  console.log("Verifying checksum...");
  const hash = createHash("sha256");
  const fileData = readFileSync(archivePath);
  hash.update(fileData);
  const actual = hash.digest("hex");
  if (actual !== platformInfo.sha256) {
    unlinkSync(archivePath);
    throw new Error(`Checksum mismatch! Expected ${platformInfo.sha256}, got ${actual}`);
  }

  // 7. Stop server
  if (isServerRunning()) {
    console.log("Stopping server...");
    await stopServer();
  }

  const dataDir = getDataDir();
  const backupDir = getBackupDir();

  // 8. Backup (unless reset)
  if (!opts.reset) {
    console.log("Creating backup...");
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

    // Backup JAR
    const jarPath = getServerJarPath();
    if (existsSync(jarPath)) {
      cpSync(jarPath, join(backupDir, `ix-memory-layer-${currentVersion}.jar`));
    }

    // Backup DB
    const graphDir = join(dataDir, "data", "graph");
    if (existsSync(graphDir)) {
      const dbBackupPath = join(backupDir, `data-schema-v${local?.schemaVersion ?? 0}`);
      if (!existsSync(dbBackupPath)) {
        cpSync(graphDir, dbBackupPath, { recursive: true });
      }
    }
  }

  // 8.5 Reset: wipe DB
  if (opts.reset) {
    console.log(chalk.yellow("Wiping database..."));
    const graphDir = join(dataDir, "data", "graph");
    if (existsSync(graphDir)) {
      rmSync(graphDir, { recursive: true, force: true });
    }
  }

  // 9. Extract new files
  console.log("Installing...");
  const extractDir = join(dataDir, "extract-tmp");
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, { stdio: "pipe" });

  // Find extracted directory
  const extracted = readdirSync(extractDir);
  const srcDir = extracted.length === 1
    ? join(extractDir, extracted[0])
    : extractDir;

  // Copy server files
  const serverDir = join(dataDir, "server");
  if (!existsSync(serverDir)) mkdirSync(serverDir, { recursive: true });

  const srcServer = join(srcDir, "server");
  if (existsSync(srcServer)) {
    cpSync(srcServer, serverDir, { recursive: true, force: true });
  }

  // Copy CLI files
  const cliDir = join(srcDir, "cli");
  if (existsSync(cliDir)) {
    // CLI is managed by the install symlink, just update in place
    const targetCli = join(dataDir, "cli");
    if (existsSync(targetCli)) rmSync(targetCli, { recursive: true, force: true });
    cpSync(cliDir, targetCli, { recursive: true });
  }

  // Cleanup
  rmSync(extractDir, { recursive: true, force: true });

  // 10. Start server (triggers migration)
  console.log("Starting server...");
  await startServer();

  // 11. Health check
  const healthy = await healthCheck();
  if (!healthy) {
    console.error(chalk.red("Server failed health check after upgrade."));
    console.log(`Run ${chalk.bold("ix upgrade --rollback")} to revert.`);
    process.exit(1);
  }

  // 12. Update manifest
  const newManifest: LocalManifest = {
    version: newVersion,
    channel: opts.channel,
    installedAt: new Date().toISOString(),
    platform,
    schemaVersion: remote.schemaVersion,
    previousVersion: currentVersion !== "unknown" ? currentVersion : undefined,
  };
  writeLocalManifest(newManifest);

  // 13. Prune old backups (keep 3)
  pruneBackups(backupDir, 3);

  console.log(chalk.green(`\nUpgraded to Ix ${newVersion}`));
  if (opts.reset) {
    console.log(chalk.yellow("Database was reset. Re-ingest with: ix ingest ./src --recursive"));
  }
}

async function doRollback() {
  const local = readLocalManifest();
  if (!local?.previousVersion) {
    throw new Error("No previous version to rollback to.");
  }

  const prev = local.previousVersion;
  console.log(`Rolling back to ${chalk.cyan(prev)}...`);

  const dataDir = getDataDir();
  const backupDir = getBackupDir();

  // Find backup jar
  const backupJar = join(backupDir, `ix-memory-layer-${prev}.jar`);
  if (!existsSync(backupJar)) {
    throw new Error(`Backup JAR not found: ${backupJar}`);
  }

  // Stop server
  if (isServerRunning()) {
    console.log("Stopping server...");
    await stopServer();
  }

  // Restore JAR
  console.log("Restoring server...");
  cpSync(backupJar, getServerJarPath(), { force: true });

  // Restore DB if backup exists
  const schemaBackups = readdirSync(backupDir)
    .filter(f => f.startsWith("data-schema-v"))
    .sort()
    .reverse();

  if (schemaBackups.length > 0) {
    const graphDir = join(dataDir, "data", "graph");
    console.log("Restoring database...");
    if (existsSync(graphDir)) rmSync(graphDir, { recursive: true, force: true });
    cpSync(join(backupDir, schemaBackups[0]), graphDir, { recursive: true });
  }

  // Start server
  console.log("Starting server...");
  await startServer();

  const healthy = await healthCheck();
  if (!healthy) {
    console.error(chalk.red("Server failed health check after rollback."));
    process.exit(1);
  }

  // Update manifest
  writeLocalManifest({
    ...local,
    version: prev,
    previousVersion: local.version,
    installedAt: new Date().toISOString(),
  });

  console.log(chalk.green(`Rolled back to Ix ${prev}`));
}

function pruneBackups(backupDir: string, keep: number) {
  if (!existsSync(backupDir)) return;
  const jars = readdirSync(backupDir)
    .filter(f => f.endsWith(".jar"))
    .map(f => ({ name: f, time: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  for (const jar of jars.slice(keep)) {
    unlinkSync(join(backupDir, jar.name));
  }
}
