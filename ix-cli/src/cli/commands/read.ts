import * as fs from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveEntity } from "../resolve.js";

export function registerReadCommand(program: Command): void {
  program
    .command("read <target>")
    .description("Read source code — by file path, path:lines, or symbol name")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--kind <kind>", "Filter symbol by kind")
    .action(async (target: string, opts: { format: string; kind?: string }) => {
      // Check if target has a line range (path:start-end)
      const lineRangeMatch = target.match(/^(.+?):(\d+)-(\d+)$/);
      const filePath = lineRangeMatch ? lineRangeMatch[1] : target;

      // Try as a file path first
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        if (lineRangeMatch) {
          const start = parseInt(lineRangeMatch[2], 10) - 1;
          const end = parseInt(lineRangeMatch[3], 10);
          const slice = lines.slice(start, end);
          if (opts.format === "json") {
            console.log(JSON.stringify({ file: filePath, lines: [start + 1, end], content: slice.join("\n") }, null, 2));
          } else {
            for (let i = 0; i < slice.length; i++) {
              console.log(`${chalk.dim(String(start + i + 1).padStart(4))} ${slice[i]}`);
            }
          }
        } else {
          if (opts.format === "json") {
            console.log(JSON.stringify({ file: filePath, lines: [1, lines.length], content }, null, 2));
          } else {
            for (let i = 0; i < lines.length; i++) {
              console.log(`${chalk.dim(String(i + 1).padStart(4))} ${lines[i]}`);
            }
          }
        }
        return;
      }

      // Not a file path — resolve as a symbol from the graph
      const client = new IxClient(getEndpoint());
      const resolved = await resolveEntity(client, target, [
        "function", "method", "class", "trait", "object", "interface", "module", "file"
      ], opts);
      if (!resolved) {
        console.error(`Could not resolve symbol: ${target}`);
        return;
      }

      const details = await client.entity(resolved.id);
      const node = details.node as any;
      const sourceUri = node.provenance?.source_uri ?? node.provenance?.sourceUri;
      if (!sourceUri || !fs.existsSync(sourceUri)) {
        const content = node.attrs?.content;
        if (content) {
          if (opts.format === "json") {
            console.log(JSON.stringify({ symbol: resolved.name, content }, null, 2));
          } else {
            console.log(content);
          }
          return;
        }
        console.error(`Source file not found: ${sourceUri ?? "(no provenance)"}`);
        return;
      }

      const fileContent = fs.readFileSync(sourceUri, "utf-8");
      const allLines = fileContent.split("\n");
      const lineStart = node.attrs?.lineStart ?? node.attrs?.line_start ?? 1;
      const lineEnd = node.attrs?.lineEnd ?? node.attrs?.line_end ?? allLines.length;

      if (opts.format === "json") {
        console.log(JSON.stringify({
          symbol: resolved.name,
          file: sourceUri,
          lines: [lineStart, lineEnd],
          content: allLines.slice(lineStart - 1, lineEnd).join("\n"),
        }, null, 2));
      } else {
        console.log(chalk.dim(`  ${sourceUri}:${lineStart}-${lineEnd}`));
        console.log();
        for (let i = lineStart - 1; i < lineEnd && i < allLines.length; i++) {
          console.log(`${chalk.dim(String(i + 1).padStart(4))} ${allLines[i]}`);
        }
      }
    });
}
