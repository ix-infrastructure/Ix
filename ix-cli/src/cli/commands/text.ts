import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import { formatTextResults, type TextResult } from "../format.js";
import { resolveWorkspaceRoot } from "../config.js";

const execFileAsync = promisify(execFile);

export function registerTextCommand(program: Command): void {
  program
    .command("text <term>")
    .description("Fast lexical/text search across the codebase (uses ripgrep)")
    .option("--limit <n>", "Max results", "20")
    .option("--path <dir>", "Restrict search to a directory", ".")
    .option("--language <lang>", "Filter by language (python, typescript, scala, etc.)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--root <dir>", "Workspace root directory")
    .addHelpText("after", "\nExamples:\n  ix text verify_token --language python\n  ix text \"class.*Service\" --limit 10 --format json\n  ix text TODO --path src/")
    .action(async (term: string, opts: { limit: string; path: string; format: string; language?: string; root?: string }) => {
      const limit = parseInt(opts.limit, 10);
      const searchPath = opts.path !== "." ? opts.path : resolveWorkspaceRoot(opts.root);
      try {
        const rgArgs = [
          "--json",
          "--max-count", String(limit),
        ];

        if (opts.language) {
          for (const g of languageGlobs(opts.language)) {
            rgArgs.push("--glob", g);
          }
        }

        rgArgs.push(term, searchPath);

        const { stdout } = await execFileAsync("rg", rgArgs, { maxBuffer: 10 * 1024 * 1024 });

        const results: TextResult[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "match") {
              const data = parsed.data;
              const filePath = data.path?.text ?? "";
              const lineNum = data.line_number ?? 0;
              results.push({
                path: filePath,
                line_start: lineNum,
                line_end: lineNum,
                snippet: data.lines?.text ?? "",
                engine: "ripgrep",
                score: 1.0,
                language: inferLanguage(filePath),
              });
            }
          } catch {
            // skip non-JSON lines
          }
        }

        formatTextResults(results.slice(0, limit), opts.format);
      } catch (err: any) {
        if (err.code === "ENOENT") {
          console.error("Error: ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep#installation");
          process.exit(1);
        }
        if (err.code === 1 || err.status === 1) {
          formatTextResults([], opts.format);
        } else {
          throw err;
        }
      }
    });
}

function inferLanguage(filePath: string): string | undefined {
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) return "javascript";
  if (filePath.endsWith(".scala") || filePath.endsWith(".sc")) return "scala";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".go")) return "go";
  if (filePath.endsWith(".rs")) return "rust";
  if (filePath.endsWith(".rb")) return "ruby";
  if (filePath.endsWith(".md")) return "markdown";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return "yaml";
  return undefined;
}

function languageGlobs(lang: string): string[] {
  switch (lang) {
    case "python": return ["*.py"];
    case "typescript": return ["*.ts", "*.tsx"];
    case "javascript": return ["*.js", "*.jsx", "*.mjs", "*.cjs"];
    case "scala": return ["*.scala", "*.sc"];
    case "java": return ["*.java"];
    case "go": return ["*.go"];
    case "rust": return ["*.rs"];
    case "ruby": return ["*.rb"];
    case "markdown": return ["*.md", "*.mdx"];
    case "config": return ["*.json", "*.yaml", "*.yml", "*.toml"];
    default: return [`*.${lang}`];
  }
}
