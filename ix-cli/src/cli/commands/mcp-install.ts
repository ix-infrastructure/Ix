import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";

interface McpConfig {
  mcpServers: Record<string, {
    type?: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
}

// Resolve server.ts relative to this file's location (works regardless of cwd)
const serverPath = join(new URL(".", import.meta.url).pathname, "../../mcp/server.ts");

const ixMcpEntry = {
  type: "stdio",
  command: "npx",
  args: ["tsx", serverPath],
  env: {
    IX_ENDPOINT: "http://localhost:8090",
  },
};

export function registerMcpInstallCommand(program: Command): void {
  program
    .command("mcp-install")
    .description("Install Ix MCP server configuration")
    .option("--cursor", "Configure for Cursor")
    .option("--claude-code", "Configure for Claude Code")
    .action(async (opts: { cursor?: boolean; claudeCode?: boolean }) => {
      if (opts.cursor) {
        await installCursor();
      } else if (opts.claudeCode) {
        await installClaudeCode();
      } else {
        await installClaudeDesktop();
      }
    });
}

async function installClaudeDesktop(): Promise<void> {
  const platform = process.platform;
  let configPath: string;
  if (platform === "darwin") {
    configPath = join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else if (platform === "win32") {
    configPath = join(homedir(), "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  } else {
    configPath = join(homedir(), ".config", "claude", "claude_desktop_config.json");
  }

  const config = await loadOrCreateConfig(configPath);
  config.mcpServers["ix-memory"] = ixMcpEntry;
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  [ok] Installed Ix MCP server in Claude Desktop config`);
  console.log(`       ${configPath}`);
  console.log("  Restart Claude Desktop to activate.");
}

async function installCursor(): Promise<void> {
  const configPath = join(process.cwd(), ".cursor", "mcp.json");
  const config = await loadOrCreateConfig(configPath);
  config.mcpServers["ix-memory"] = ixMcpEntry;
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  [ok] Installed Ix MCP server in Cursor config`);
  console.log(`       ${configPath}`);
}

async function installClaudeCode(): Promise<void> {
  // Claude Code reads MCP config from .mcp.json in the project root
  const configPath = join(process.cwd(), ".mcp.json");
  const config = await loadOrCreateConfig(configPath);
  config.mcpServers["ix-memory"] = ixMcpEntry;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  [ok] Installed Ix MCP server in Claude Code config`);
  console.log(`       ${configPath}`);
  console.log("  Restart Claude Code to activate.");
}

async function loadOrCreateConfig(path: string): Promise<McpConfig> {
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<McpConfig>;
      return { mcpServers: {}, ...parsed };
    } catch {
      return { mcpServers: {} };
    }
  }
  return { mcpServers: {} };
}
