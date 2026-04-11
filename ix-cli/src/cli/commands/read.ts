import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { absoluteFromSourceUri, getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { resolveEntityFull } from "../resolve.js";
import { stderr } from "../stderr.js";
import { isFileStale } from "../stale.js";
import { relativePath } from "../format.js";

/** Common file extensions that signal the target is file-like, not a symbol name. */
const FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".scala", ".sc", ".java", ".py", ".rb", ".go", ".rs",
  ".md", ".mdx", ".rst", ".txt",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".conf",
  ".sql", ".graphql", ".gql", ".sh", ".bash",
  ".html", ".css", ".scss", ".less",
]);

function looksFileLike(target: string): boolean {
  if (target.includes("/") || target.includes("\\")) return true;
  const ext = path.extname(target).toLowerCase();
  if (ext && FILE_EXTENSIONS.has(ext)) return true;
  return false;
}

interface ReadResult {
  targetType: "file" | "file-range" | "filename-match" | "symbol";
  path: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  symbol?: string;
  kind?: string;
  stale?: boolean;
  warning?: string;
}

interface AmbiguityResult {
  targetType: "ambiguous-file" | "ambiguous-symbol";
  candidates: Array<{ name: string; kind?: string; path?: string; id?: string; rank?: number }>;
  diagnostics?: Array<{ code: string; message: string }>;
}

async function checkStale(client: IxClient, filePath: string): Promise<boolean> {
  try { return await isFileStale(client, filePath); } catch { return false; }
}

function readFileRange(filePath: string, start?: number, end?: number): { content: string; lineStart: number; lineEnd: number } {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const lineStart = start ?? 1;
  const lineEnd = end ?? lines.length;
  const content = lines.slice(lineStart - 1, lineEnd).join("\n");
  return { content, lineStart, lineEnd };
}

function outputResult(result: ReadResult, format: string): void {
  if (format === "json") {
    const out = { ...result, path: relativePath(result.path) ?? result.path };
    console.log(JSON.stringify(out, null, 2));
  } else {
    if (result.stale) stderr(chalk.yellow("⚠ File has changed since last ingest. Run ix map to update.\n"));
    if (result.targetType === "symbol" || result.targetType === "filename-match") {
      stderr(chalk.dim(`  ${result.path}:${result.lineStart}-${result.lineEnd}\n`));
    }
    const lines = result.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      console.log(`${chalk.dim(String(result.lineStart + i).padStart(4))} ${lines[i]}`);
    }
  }
}

function outputAmbiguity(result: AmbiguityResult, target: string, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const label = result.targetType === "ambiguous-file" ? "file" : "symbol";
    stderr(`Ambiguous ${label} "${target}":`);
    for (let i = 0; i < result.candidates.length; i++) {
      const c = result.candidates[i];
      const kindStr = c.kind ? chalk.cyan(c.kind.padEnd(10)) : "";
      const pathStr = c.path ? chalk.dim(` ${c.path}`) : "";
      const idStr = c.id ? chalk.dim(` ${c.id.slice(0, 8)}`) : "";
      stderr(`  ${i + 1}. ${kindStr}${idStr}  ${c.name}${pathStr}`);
    }
    if (result.targetType === "ambiguous-file") {
      stderr(chalk.dim("\nProvide a more specific path to disambiguate."));
    } else {
      stderr(chalk.dim("\nUse --pick <n>, --kind, or --path to disambiguate."));
    }
  }
}

export function registerReadCommand(program: Command): void {
  program
    .command("read <target>")
    .description("Read raw file content, line ranges, or symbol source code")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--kind <kind>", "Filter symbol by kind")
    .option("--path <path>", "Prefer symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--root <dir>", "Workspace root directory")
    .addHelpText("after", `\nResolution order:
  1. Exact file path          ix read src/main.ts
  2. File path with line range ix read src/main.ts:10-50
  3. Unique filename match     ix read Node.scala
  4. Unique symbol match       ix read IngestionService
  5. Ambiguity candidates      (prompted to disambiguate)

Examples:
  ix read src/cli/commands/read.ts
  ix read Node.scala
  ix read Node.scala:30-50
  ix read IngestionService
  ix read ingestFile --kind method
  ix read verify_token --path auth`)
    .action(async (target: string, opts: { format: string; kind?: string; path?: string; pick?: string; root?: string }) => {
      const root = resolveWorkspaceRoot(opts.root);
      const client = new IxClient(getEndpoint());

      // --- Step 1: Parse line range if present ---
      const lineRangeMatch = target.match(/^(.+?):(\d+)-(\d+)$/);
      const rawTarget = lineRangeMatch ? lineRangeMatch[1] : target;
      const rangeStart = lineRangeMatch ? parseInt(lineRangeMatch[2], 10) : undefined;
      const rangeEnd = lineRangeMatch ? parseInt(lineRangeMatch[3], 10) : undefined;

      // --- Step 2: Try exact file path ---
      const resolvedPath = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(root, rawTarget);
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
        const stale = await checkStale(client, resolvedPath);
        const { content, lineStart, lineEnd } = readFileRange(resolvedPath, rangeStart, rangeEnd);
        const result: ReadResult = {
          targetType: lineRangeMatch ? "file-range" : "file",
          path: resolvedPath,
          lineStart,
          lineEnd,
          content,
        };
        if (stale) { result.stale = true; result.warning = "Results may be stale; file has changed since last ingest."; }
        outputResult(result, opts.format);
        return;
      }

      // --- Step 3: Try unique filename match (always, not just file-like targets) ---
      // read should prefer resolving to a real file before trying symbol match.
      // e.g. "ix read Node" should find Node.scala before trying symbol resolution.
      {
        const filenameMatches = await tryFilenameMatch(client, rawTarget);
        if (filenameMatches.length === 1) {
          const matchPath = filenameMatches[0].path;
          if (matchPath && fs.existsSync(matchPath)) {
            const stale = await checkStale(client, matchPath);
            const { content, lineStart, lineEnd } = readFileRange(matchPath, rangeStart, rangeEnd);
            const result: ReadResult = {
              targetType: "filename-match",
              path: matchPath,
              lineStart,
              lineEnd,
              content,
            };
            if (stale) { result.stale = true; result.warning = "Results may be stale; file has changed since last ingest."; }
            outputResult(result, opts.format);
            return;
          }
        }
        if (filenameMatches.length > 1) {
          outputAmbiguity({
            targetType: "ambiguous-file",
            candidates: filenameMatches.map((m, i) => ({ name: m.name, path: m.path, rank: i + 1 })),
            diagnostics: [{ code: "ambiguous_resolution", message: "Provide a more specific path to disambiguate." }],
          }, target, opts.format);
          return;
        }
        // No filename match — fall through to symbol resolution
      }

      // --- Step 4: Try unique symbol match ---
      const symbolResult = await trySymbolMatch(client, rawTarget, { kind: opts.kind, path: opts.path, pick: opts.pick ? parseInt(opts.pick, 10) : undefined });
      if (symbolResult.type === "resolved") {
        const { node, sourceUri } = symbolResult;
        // sourceUri coming from the graph is workspace-relative under the
        // client-agnostic backend. Resolve it against the active workspace
        // root before any fs call.
        const absSourceUri = sourceUri ? absoluteFromSourceUri(sourceUri, opts.root) : null;
        const stale = absSourceUri ? await checkStale(client, absSourceUri) : false;

        // If the source file exists, extract the symbol's lines
        if (absSourceUri && fs.existsSync(absSourceUri)) {
          const lineStart = node.attrs?.lineStart ?? node.attrs?.line_start ?? 1;
          const lineEnd = node.attrs?.lineEnd ?? node.attrs?.line_end;
          const fileContent = fs.readFileSync(absSourceUri, "utf-8");
          const allLines = fileContent.split("\n");
          const effectiveEnd = lineEnd ?? allLines.length;
          const content = allLines.slice(lineStart - 1, effectiveEnd).join("\n");
          const result: ReadResult = {
            targetType: "symbol",
            path: absSourceUri,
            lineStart,
            lineEnd: effectiveEnd,
            content,
            symbol: node.name,
            kind: node.kind,
          };
          if (stale) { result.stale = true; result.warning = "Results may be stale; file has changed since last ingest."; }
          outputResult(result, opts.format);
          return;
        }

        // No source file — try attrs.content
        const attrContent = node.attrs?.content;
        if (attrContent) {
          const lines = String(attrContent).split("\n");
          const result: ReadResult = {
            targetType: "symbol",
            path: absSourceUri ?? sourceUri ?? "(no source file)",
            lineStart: 1,
            lineEnd: lines.length,
            content: String(attrContent),
            symbol: node.name,
            kind: node.kind,
          };
          if (stale) { result.stale = true; result.warning = "Results may be stale; file has changed since last ingest."; }
          outputResult(result, opts.format);
          return;
        }

        stderr(`Source file not found for symbol: ${node.name} (${absSourceUri ?? sourceUri ?? "no provenance"})`);
        return;
      }

      if (symbolResult.type === "ambiguous") {
        outputAmbiguity({
          targetType: "ambiguous-symbol",
          candidates: symbolResult.candidates.map((c, i) => ({ ...c, rank: i + 1 })),
          diagnostics: [{ code: "ambiguous_resolution", message: "Use --pick <n> or --path to disambiguate." }],
        }, target, opts.format);
        return;
      }

      stderr(`Could not resolve "${target}" as a file or symbol.`);
    });
}

/**
 * Search the graph for file nodes whose name matches the target filename.
 * Tries multiple search strategies to find files even when the bare name
 * is ambiguous or crowded out by other results.
 */
async function tryFilenameMatch(
  client: IxClient,
  target: string
): Promise<Array<{ name: string; path: string }>> {
  const basename = path.basename(target);
  const hasExtension = path.extname(basename) !== "";

  // Strategy 1: Search with the exact target (may include extension)
  let nodes = await client.search(basename, { limit: 20, kind: "file" });

  // Strategy 2: If bare name (no extension), also search with common extensions
  // to avoid being crowded out by unrelated results
  if (!hasExtension && !filterMatches(nodes, basename).length) {
    const extensions = [".scala", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".js", ".md"];
    for (const ext of extensions) {
      const extNodes = await client.search(basename + ext, { limit: 5, kind: "file" });
      const extMatches = filterMatches(extNodes, basename);
      if (extMatches.length > 0) {
        nodes = [...extNodes, ...nodes];
        break;
      }
    }
  }

  const matches = filterMatches(nodes, basename);

  // Deduplicate by path
  const seen = new Set<string>();
  return matches.filter(m => {
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  });
}

/** Filter nodes to those whose filename actually matches the target basename. */
function filterMatches(
  nodes: any[],
  basename: string
): Array<{ name: string; path: string }> {
  const basenameNoExt = basename.replace(/\.[^.]+$/, "");
  const results: Array<{ name: string; path: string }> = [];

  for (const n of nodes) {
    const name: string = n.name || "";
    const nameNoExt = name.replace(/\.[^.]+$/, "");
    const uri: string = n.provenance?.sourceUri ?? n.provenance?.source_uri ?? "";

    if (
      name === basename ||                 // exact: Node.scala === Node.scala
      nameNoExt === basename ||            // bare name: Node === Node (from Node.scala)
      nameNoExt === basenameNoExt ||       // both stripped: Node === Node
      name.endsWith(`/${basename}`) ||
      uri.endsWith(`/${basename}`) || uri.endsWith(`/${basename}`)
    ) {
      results.push({ name: name || basename, path: uri });
    }
  }

  return results;
}

type SymbolResult =
  | { type: "resolved"; node: any; sourceUri: string | null }
  | { type: "ambiguous"; candidates: Array<{ name: string; kind?: string; path?: string; id?: string }> }
  | { type: "not-found" };

/**
 * Search the graph for a symbol using the shared scored resolver.
 * read prefers file/structural entities (class, object, file) before methods/functions.
 *
 * Calls resolveEntityFull once to avoid duplicate ambiguity output.
 */
async function trySymbolMatch(
  client: IxClient,
  symbol: string,
  opts: { kind?: string; path?: string; pick?: number }
): Promise<SymbolResult> {
  const preferredKinds = ["file", "class", "object", "trait", "interface", "module", "function", "method"];
  const full = await resolveEntityFull(client, symbol, preferredKinds, opts);

  if (full.resolved) {
    const details = await client.entity(full.entity.id);
    const fullNode = details.node as any;
    const sourceUri = fullNode.provenance?.source_uri ?? fullNode.provenance?.sourceUri ?? null;
    return { type: "resolved", node: fullNode, sourceUri };
  }

  if (full.ambiguous) {
    return {
      type: "ambiguous",
      candidates: full.result.candidates.map(c => ({
        name: c.name, kind: c.kind, path: c.path, id: c.id,
      })),
    };
  }

  return { type: "not-found" };
}
