import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { bootstrap } from "../bootstrap.js";
import { loadWatchIngestionModules } from "./ingestion-loader.js";
import { readFileContent } from "./watch-utils.js";
const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".scala", ".sc", ".java",
  ".py", ".rb", ".go", ".rs", ".kt", ".kts", ".cs", ".php", ".swift",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp",
  ".yaml", ".yml",
]);

const SUPPORTED_NAMES = new Set([
  ".gitignore", ".gitattributes", ".editorconfig", ".env",
  ".eslintrc", ".prettierrc", ".babelrc",
  "Makefile", "Dockerfile", "Procfile", "Gemfile", "Rakefile",
  "BUILD", "WORKSPACE",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next",
  ".cache", "__pycache__", ".ix", ".claude",
]);

const DEBOUNCE_MS = 300;

/** Compute SHA-256 hash of file content for dedup. */
function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("Watch files and auto-ingest on changes")
    .option("--path <path>", "Restrict watching to a subdirectory")
    .option("--root <dir>", "Workspace root directory")
    .action(async (opts: { path?: string; root?: string }) => {
      try {
        await bootstrap();
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exit(1);
      }

      const root = resolveWorkspaceRoot(opts.root);
      const watchPath = opts.path
        ? path.resolve(root, opts.path)
        : root;

      if (!fs.existsSync(watchPath)) {
        console.error(`Path does not exist: ${watchPath}`);
        process.exit(1);
      }

      const client = new IxClient(getEndpoint());

      const relative = path.relative(root, watchPath) || ".";
      console.log(chalk.cyan(`[watch] Watching ${relative}`));
      console.log(chalk.dim(`[watch] Debounce: ${DEBOUNCE_MS}ms`));
      console.log(chalk.dim("[watch] Press Ctrl+C to stop.\n"));

      // Track pending changes with debounce + content hash dedup
      const pending = new Map<string, NodeJS.Timeout>();
      const lastHash = new Map<string, string>();

      function shouldWatch(filePath: string): boolean {
        const ext = path.extname(filePath).toLowerCase();
        const basename = path.basename(filePath);
        if (!SUPPORTED_EXTENSIONS.has(ext) && !SUPPORTED_NAMES.has(basename)) return false;
        // Check no segment is an ignored dir
        const segments = path.relative(root, filePath).split(path.sep);
        return !segments.some(s => IGNORE_DIRS.has(s));
      }

      async function ingestFile(filePath: string): Promise<void> {
        const [{ parseFile }, { buildPatch }] = await loadWatchIngestionModules();
        const rel = path.relative(root, filePath);

        // Re-read content at actual ingest time (not at event time)
        const content = readFileContent(filePath);
        if (content === null) return;

        // Skip if content hash is unchanged since last ingest
        const hash = hashContent(content);
        if (lastHash.get(filePath) === hash) {
          console.log(`${chalk.dim("[watch]")} unchanged (hash): ${rel}`);
          return;
        }

        try {
          const parsed = parseFile(filePath, content);
          if (!parsed) {
            console.log(`${chalk.dim("[watch]")} skipped (unsupported): ${rel}`);
            return;
          }
          const patch = buildPatch(parsed, hash);
          const result = await client.commitPatch(patch);
          lastHash.set(filePath, hash);
          console.log(`${chalk.cyan("[watch]")} ingested: ${chalk.bold(rel)} → rev ${result.rev}`);

          // Recalculate the map after successful ingestion
          try {
            const mapResult = await client.map();
            const systems = mapResult.regions?.filter((r: any) => r.label_kind === "system").length ?? 0;
            const subsystems = mapResult.regions?.filter((r: any) => r.label_kind === "subsystem").length ?? 0;
            const modules = mapResult.regions?.filter((r: any) => r.label_kind === "module").length ?? 0;
            console.log(`${chalk.cyan("[watch]")} map updated: ${systems}s/${subsystems}ss/${modules}m regions`);
          } catch (mapErr: any) {
            console.error(`${chalk.red("[watch]")} map error: ${mapErr.message}`);
          }
        } catch (err: any) {
          console.error(`${chalk.red("[watch]")} error ingesting ${rel}: ${err.message}`);
        }
      }

      // Use fs.watch recursively
      try {
        const watcher = fs.watch(watchPath, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const fullPath = path.resolve(watchPath, filename);
          if (!shouldWatch(fullPath)) return;

          // Check file still exists (might be a delete event)
          if (!fs.existsSync(fullPath)) return;

          const rel = path.relative(root, fullPath);

          // Cancel any existing debounce for this file
          const existing = pending.get(fullPath);
          if (existing) clearTimeout(existing);

          // Set new debounce — content is re-read at ingest time, not here
          pending.set(fullPath, setTimeout(async () => {
            pending.delete(fullPath);
            console.log(`${chalk.dim("[watch]")} changed: ${rel}`);
            await ingestFile(fullPath);
          }, DEBOUNCE_MS));
        });

        // Keep process alive
        process.on("SIGINT", () => {
          watcher.close();
          // Clear pending timers
          for (const timer of pending.values()) clearTimeout(timer);
          console.log(chalk.dim("\n[watch] Stopped."));
          process.exit(0);
        });
      } catch (err: any) {
        // Fallback to polling if fs.watch with recursive isn't supported
        if (err.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
          console.log(chalk.dim("[watch] Falling back to polling mode (2s interval)..."));
          await pollMode(watchPath, root, client);
        } else {
          throw err;
        }
      }
    });
}

/**
 * Fallback polling mode for platforms where recursive fs.watch isn't available.
 */
async function pollMode(
  watchPath: string,
  root: string,
  client: IxClient
): Promise<void> {
  const [{ parseFile }, { buildPatch }] = await loadWatchIngestionModules();
  const mtimes = new Map<string, number>();

  function collectFiles(dir: string): string[] {
    const results: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.isDirectory()) continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext) || SUPPORTED_NAMES.has(entry.name)) {
            results.push(fullPath);
          }
        }
      }
    }
    return results;
  }

  // Initial scan
  for (const f of collectFiles(watchPath)) {
    try { mtimes.set(f, fs.statSync(f).mtimeMs); } catch {}
  }

  const poll = async () => {
    const currentFiles = collectFiles(watchPath);
    const changed: string[] = [];

    for (const f of currentFiles) {
      try {
        const mtime = fs.statSync(f).mtimeMs;
        const prev = mtimes.get(f);
        if (prev === undefined || mtime > prev) {
          changed.push(f);
          mtimes.set(f, mtime);
        }
      } catch {}
    }

    let anyIngested = false;
    for (const f of changed) {
      const rel = path.relative(root, f);
      console.log(`${chalk.dim("[watch]")} changed: ${rel}`);
      try {
        const content = readFileContent(f);
        if (!content) continue;
        const parsed = parseFile(f, content);
        if (!parsed) continue;
        const hash = hashContent(content);
        const patch = buildPatch(parsed, hash);
        const result = await client.commitPatch(patch);
        console.log(`${chalk.cyan("[watch]")} ingested: ${chalk.bold(rel)} → rev ${result.rev}`);
        anyIngested = true;
      } catch (err: any) {
        console.error(`${chalk.red("[watch]")} error: ${err.message}`);
      }
    }

    // Recalculate the map once after processing all changed files
    if (anyIngested) {
      try {
        const mapResult = await client.map();
        const systems = mapResult.regions?.filter((r: any) => r.label_kind === "system").length ?? 0;
        const subsystems = mapResult.regions?.filter((r: any) => r.label_kind === "subsystem").length ?? 0;
        const modules = mapResult.regions?.filter((r: any) => r.label_kind === "module").length ?? 0;
        console.log(`${chalk.cyan("[watch]")} map updated: ${systems}s/${subsystems}ss/${modules}m regions`);
      } catch (mapErr: any) {
        console.error(`${chalk.red("[watch]")} map error: ${mapErr.message}`);
      }
    }
  };

  setInterval(poll, 2000);

  process.on("SIGINT", () => {
    console.log(chalk.dim("\n[watch] Stopped."));
    process.exit(0);
  });
}

