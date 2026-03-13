import chalk from "chalk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalManifest, detectPlatform } from "./manifest.js";
import { getServerVersion, healthCheck } from "./server-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getCliVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

export async function printVersionInfo(): Promise<void> {
  const cliVersion = getCliVersion();
  const manifest = readLocalManifest();
  const platform = detectPlatform();
  const channel = manifest?.channel ?? "stable";

  console.log(`ix ${chalk.bold(cliVersion)} (${channel})`);

  // Try to get server info
  const isHealthy = await healthCheck(2000);
  if (isHealthy) {
    const serverInfo = await getServerVersion();
    if (serverInfo) {
      console.log(`  server: ${serverInfo.version}`);
      console.log(`  schema: ${serverInfo.schemaVersion}`);
    }
  } else {
    console.log(`  server: ${chalk.dim("(not running)")}`);
    console.log(`  schema: ${chalk.dim("(not running)")}`);
  }

  console.log(`  platform: ${platform}`);
}
