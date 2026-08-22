import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { absoluteFromSourceUri, getEndpoint, isReadablePath, readableRoots, resolveWorkspaceRoot } from "../config.js";
import { resolveEntityFull, activeReadScope, ensureReadScope } from "../resolve.js";
import { stderr } from "../stderr.js";
import { isFileStale } from "../stale.js";
import { relativePath } from "../format.js";
import { llmLine, printLlmLines } from "../llm.js";
import { parsePickOption } from "../options.js";

export interface ReadResult {
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

function checkStale(filePath: string): boolean {
  try { return isFileStale(filePath); } catch { return false; }
}

/**
 * Refuse a file outside every readable workspace root, and say so.
 *
 * `ix read` resolves its target four ways, and three of them can end at an
 * arbitrary absolute path: the caller passes one directly, or the graph hands
 * back a `source_uri` that is already absolute. Nothing downstream re-checked
 * it, so `ix read /etc/shadow` read `/etc/shadow` — no workspace involved, no
 * backend involved. That matters most through `ix mcp`, where the caller is an
 * agent and the target is a string it chose.
 *
 * Returns true when the read may proceed. On refusal it prints the reason and
 * the roots that WOULD have been allowed, because "denied" with no boundary is
 * indistinguishable from a broken install.
 */
function guardReadable(absPath: string, explicitRoot: string | undefined, what: string): boolean {
  if (isReadablePath(absPath, explicitRoot)) return true;
  stderr(chalk.red(`Refusing to read ${what} outside the workspace: ${absPath}`));
  for (const root of readableRoots(explicitRoot)) stderr(chalk.dim(`  allowed root: ${root}`));
  stderr(chalk.dim("  Use --root to read from a different workspace, or ix init to register one."));
  return false;
}

function readFileRange(filePath: string, start?: number, end?: number): { content: string; lineStart: number; lineEnd: number } {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const lineStart = start ?? 1;
  const lineEnd = end ?? lines.length;
  const content = lines.slice(lineStart - 1, lineEnd).join("\n");
  return { content, lineStart, lineEnd };
}

/**
 * `ix read --format llm`.
 *
 * The one command whose payload is not records: an agent asked for source and
 * wants it byte-for-byte. Everything around it goes, though — `text` prefixes
 * every single line with a 4-column padded line number and an ANSI dim escape,
 * which on a 200-line read is 200 gutters of pure overhead for information the
 * `line_start` field already carries once.
 *
 * The `content lines=<n>` record makes the block self-delimiting, so a
 * consumer knows exactly how many following lines are payload and never has to
 * guess whether a line of source is another record.
 */
export function renderReadLlm(result: ReadResult): string[] {
  const contentLines = result.content.split("\n");
  return [
    llmLine("file", [
      ["path", relativePath(result.path) ?? result.path],
      ["line_start", String(result.lineStart)],
      ["line_end", String(result.lineEnd)],
      ["target", result.targetType],
      ["symbol", result.symbol],
      ["kind", result.kind],
      ["stale", result.stale ? "true" : null],
    ]),
    llmLine("content", [["lines", String(contentLines.length)]]),
    ...contentLines,
  ];
}

/** `ix read --format llm` when the target resolves to more than one thing. */
export function renderReadAmbiguityLlm(result: AmbiguityResult, target: string): string[] {
  const isFile = result.targetType === "ambiguous-file";
  const lines = [
    llmLine("ambiguous", [
      ["kind", isFile ? "file" : "symbol"],
      ["target", target],
      ["count", String(result.candidates.length)],
    ]),
  ];
  result.candidates.forEach((c, i) => {
    lines.push(llmLine("candidate", [
      ["n", String(i + 1)],
      ["name", c.name],
      ["kind", c.kind],
      ["path", c.path ? relativePath(c.path) ?? c.path : undefined],
      ["id", c.id],
    ]));
  });
  lines.push(llmLine("hint", [[
    "text",
    isFile
      ? "Provide a more specific path to disambiguate."
      : "Use --pick <n>, --kind, or --path to disambiguate.",
  ]]));
  for (const d of result.diagnostics ?? []) {
    lines.push(llmLine("diagnostic", [["code", d.code], ["message", d.message]]));
  }
  return lines;
}

// Exported for the tests: the `content lines=<n>` invariant is a property of
// render *composed with* print, not of either alone. Asserting on
// renderReadLlm's return value passes just as happily when printLlmLines drops
// the blank lines out from under the count.
export function outputResult(result: ReadResult, format: string): void {
  if (format === "llm") {
    printLlmLines(renderReadLlm(result));
  } else if (format === "json") {
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
  if (format === "llm") {
    printLlmLines(renderReadAmbiguityLlm(result, target));
  } else if (format === "json") {
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
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--kind <kind>", "Filter symbol by kind")
    .option("--path <path>", "Prefer symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
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
    .action(async (target: string, opts: { format: string; kind?: string; path?: string; pick?: number; root?: string }) => {
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
        if (!guardReadable(resolvedPath, opts.root, "file")) return;
        const stale = checkStale(resolvedPath);
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
        const filenameMatches = await tryFilenameMatch(client, rawTarget, root);
        if (filenameMatches.length === 1) {
          const matchPath = filenameMatches[0].path;
          if (matchPath && fs.existsSync(matchPath)) {
            // The path came back from the graph rather than the caller, so this
            // guard is what stops a backend from naming a file off the disk.
            if (!guardReadable(matchPath, opts.root, "graph file match")) return;
            const stale = checkStale(matchPath);
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
      const symbolResult = await trySymbolMatch(client, rawTarget, { kind: opts.kind, path: opts.path, pick: opts.pick });
      if (symbolResult.type === "resolved") {
        const { node, sourceUri } = symbolResult;
        // sourceUri coming from the graph is workspace-relative under the
        // client-agnostic backend. Resolve it against the active workspace
        // root before any fs call.
        const absSourceUri = sourceUri ? absoluteFromSourceUri(sourceUri, opts.root) : null;
        const stale = absSourceUri ? checkStale(absSourceUri) : false;

        // If the source file exists, extract the symbol's lines
        if (absSourceUri && fs.existsSync(absSourceUri)) {
          // absoluteFromSourceUri passes an already-absolute source_uri through
          // untouched, so a graph row can still point anywhere on the disk.
          if (!guardReadable(absSourceUri, opts.root, "symbol source")) return;
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
  target: string,
  root: string
): Promise<Array<{ name: string; path: string }>> {
  const basename = path.basename(target);
  const hasExtension = path.extname(basename) !== "";

  // Strategy 0: the workspace itself. `read` can only display a file that
  // exists locally — every graph result below is re-checked with `existsSync`
  // and dropped when it is missing — so disk is the authority here, not a cache
  // of the backend. It answers in milliseconds against seconds, and reaching it
  // before `ensureReadScope` also skips that call's scope lookup, which is its
  // own ~1.5 s on a large graph.
  const local = findLocalBasenameMatches(root, basename);
  if (local.paths.length > 0) {
    return local.paths.map(p => ({ name: path.basename(p), path: p }));
  }

  // An extension-less target with no local file of that basename is not a
  // filename in this workspace, and the graph cannot say otherwise: `ix map`'s
  // IGNORE_DIRS is a strict superset of the walk's, so every file the graph
  // holds for this workspace is a file the walk visited. Asking the backend
  // anyway costs ~8 s of `kind: file` search that returns empty every time.
  // Targets that DO carry an extension still go to the graph, which is what
  // answers `ix read Node.scala` for a file that is ingested but not checked out.
  if (!hasExtension && local.exhaustive) return [];

  // Scope to the active workspace / co-ingest system / Path-2 stitched system.
  await ensureReadScope(client);
  const scope = activeReadScope();

  // Strategy 1: Search with the exact target (may include extension)
  let nodes = await client.search(basename, { limit: 20, kind: "file", ...scope });

  // Strategy 2: If bare name (no extension), also search with common extensions
  // to avoid being crowded out by unrelated results — a bare `upgrade` search
  // is a substring match, and on a large graph the file actually called
  // `upgrade.ts` does not survive the backend's LIMIT.
  //
  // Gated on `local.exhaustive`, and that gate is the whole point. These nine
  // searches are fired concurrently, and nine concurrent unindexed scans do not
  // cost what one costs: measured on a 1.16M-node graph they take ~54 s EACH
  // rather than ~10 s, because they contend for the same collection. For a
  // symbol like `registerUpgradeCommand` all nine return empty, and `ix read`
  // spent 60-80 s before reaching the symbol lookup that answers it.
  //
  // When the walk above completed, "no local file has this basename" is proven,
  // and a graph hit could not be displayed anyway. Only when the walk ran out
  // of budget is the question still open, and then the fallback still runs.
  if (!hasExtension && !filterMatches(nodes, basename).length) {
    const extensions = [".scala", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".js", ".md"];
    const perExt = await Promise.all(
      extensions.map(ext =>
        client.search(basename + ext, { limit: 5, kind: "file", ...scope })
          .then(r => (filterMatches(r, basename).length ? r : []))
          .catch(() => [] as any[])),
    );
    const merged = perExt.flat();
    if (merged.length) nodes = [...merged, ...nodes];
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

/** Directories a workspace walk must not descend into. Mirrors stale.ts. */
const WALK_IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next",
  ".cache", "__pycache__", ".ix", ".claude",
]);

/** How many directory entries a single basename lookup will look at. */
const WALK_ENTRY_BUDGET = 40_000;

interface LocalMatches {
  paths: string[];
  /** False when the budget ran out, i.e. "no match" is not a proven answer. */
  exhaustive: boolean;
}

/**
 * Find files in the workspace whose basename matches `target`, on disk.
 *
 * `read` can only ever *display* a file that exists locally — the graph branch
 * below re-checks `existsSync` on whatever path the backend hands back and
 * falls through when it is missing. So the filesystem is not a shortcut here,
 * it is the authority, and it answers in milliseconds where the graph takes
 * seconds.
 *
 * Returns `exhaustive: false` if the entry budget ran out. A negative answer is
 * only trustworthy when the whole workspace was walked, and the caller uses
 * that distinction to decide whether it may skip the backend fallback.
 */
function findLocalBasenameMatches(root: string, target: string, limit = 25): LocalMatches {
  const wanted = path.basename(target);
  const wantedNoExt = wanted.replace(/\.[^.]+$/, "");
  const paths: string[] = [];
  const stack = [root];
  let budget = WALK_ENTRY_BUDGET;

  while (stack.length > 0 && paths.length < limit) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is not an error for a lookup
    }
    for (const entry of entries) {
      if (--budget <= 0) return { paths, exhaustive: false };
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || WALK_IGNORE_DIRS.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue; // symlinks are not followed
      const nameNoExt = entry.name.replace(/\.[^.]+$/, "");
      if (entry.name === wanted || nameNoExt === wanted || nameNoExt === wantedNoExt) {
        paths.push(path.join(current, entry.name));
        if (paths.length >= limit) return { paths, exhaustive: true };
      }
    }
  }
  return { paths, exhaustive: stack.length === 0 };
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
