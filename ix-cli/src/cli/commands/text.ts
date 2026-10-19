// Copyright 2026 Ix Infrastructure Inc.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import type { Command } from "commander";
import { formatTextResults, printJson, sliceRanked, type TextResult } from "../format.js";
import { nextPageCommand, OFFSET_FLAG, parseOffset } from "../paging.js";
import { isPathInsideResolvedRoot, resolveWorkspaceRoot } from "../config.js";
import { stderr } from "../stderr.js";
import { llmError } from "../llm.js";
import { currentRunSignal } from "../../client/run-signal.js";

/**
 * Runs ripgrep and returns at most `limit` match lines. `matched`, when given,
 * counts every match record within the per-file `--max-count`, kept or not.
 * `capped` says some file has more matches than `--max-count` let through, so
 * the scan left matches out. The command sorts whatever comes back, so an
 * injected executor's order does not matter.
 */
type RunRipgrep = (args: string[], limit: number) => Promise<{ stdout: string; matched?: number; capped?: boolean }>;

/**
 * Max characters of context kept in one `ix text` snippet. A single minified
 * bundle or lockfile line can be tens of KB; one row must never flood the
 * agent's context. The match itself stays whole (up to this same cap).
 */
export const SNIPPET_MAX_CHARS = 200;

/**
 * Trim a ripgrep line to a window of about `cap` characters around the first
 * submatch, with `…` on each cut side. Lines at or under the cap are returned
 * unchanged. `submatches` carry UTF-8 byte offsets (rg JSON), not string indices.
 * A match longer than the cap keeps its first `cap` characters plus `…`.
 */
export function clipSnippet(
  text: string,
  submatches?: Array<{ start?: number; end?: number }>,
  cap = SNIPPET_MAX_CHARS,
): string {
  const eol = /\r?\n$/.exec(text)?.[0] ?? "";
  const body = eol ? text.slice(0, text.length - eol.length) : text;
  if (body.length <= cap) return text;

  const bytes = Buffer.from(text, "utf8");
  const toIndex = (n: number) => Math.min(bytes.subarray(0, n).toString("utf8").length, body.length);
  let start = 0;
  let end = 0;
  const m = submatches?.[0];
  if (
    m && Number.isInteger(m.start) && Number.isInteger(m.end) &&
    m.start! >= 0 && m.start! <= m.end! && m.end! <= bytes.length
  ) {
    start = toIndex(m.start!);
    end = Math.max(start, toIndex(m.end!));
  }

  let left: number;
  let right: number;
  if (end - start >= cap) {
    left = start;
    right = start + cap;
  } else {
    const budget = cap - (end - start);
    const leftAvail = start;
    const rightAvail = body.length - end;
    const half = Math.floor(budget / 2);
    const l = Math.min(leftAvail, half);
    const r = Math.min(rightAvail, budget - l);
    const l2 = Math.min(leftAvail, budget - r);
    left = start - l2;
    right = end + r;
  }
  // Do not split surrogate pairs.
  const isLow = (i: number) => { const c = body.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
  const isHigh = (i: number) => { const c = body.charCodeAt(i); return c >= 0xd800 && c <= 0xdbff; };
  if (left > 0 && left < body.length && isLow(left)) left++;
  if (right < body.length && right > left && isHigh(right - 1)) right--;

  return (left > 0 ? "…" : "") + body.slice(left, right) + (right < body.length ? "…" : eol);
}

/**
 * Keep the best `k` of `items` under `compare`, in that order.
 *
 * The sort is stable, so items that compare equal keep the order they arrived
 * in — which makes arrival the last tie-break without a sequence field.
 */
export function keepTopK<T>(items: T[], k: number, compare: (a: T, b: T) => number): T[] {
  const sorted = [...items].sort(compare);
  return sorted.length > k ? sorted.slice(0, Math.max(k, 0)) : sorted;
}

/**
 * The default executor. `root` is the workspace root matches are ranked
 * against: the band regexes have to see workspace-relative paths, or a root
 * under a `tests/` directory would put every match in the test band.
 *
 * ripgrep is asked for one match per file more than `--max-count` says. That
 * extra match is never kept or counted; it only shows the file had more. A
 * file with exactly `--max-count` matches looks the same as a cut-off one
 * otherwise, and calling it cut off told every `--limit 1` search to narrow.
 */
async function runRipgrep(args: string[], limit: number, root: string): Promise<{ stdout: string; matched: number; capped: boolean }> {
  const { argv, perFileCap } = probePerFileCap(args);
  const perFile = new Map<string, number>();
  let capped = false;
  return new Promise((resolve, reject) => {
    // Killed when an `ix mcp` tool call that runs it times out (run-signal.ts).
    const child = spawn("rg", argv, { stdio: ["ignore", "pipe", "pipe"], signal: currentRunSignal() });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    // The best `limit` matches seen so far, not the first `limit` to arrive:
    // ripgrep's walker is parallel, so which matches arrive first changes from
    // run to run. Ranking every match keeps the output byte-stable. The buffer
    // is cut back to `limit` whenever it reaches twice that, so memory stays
    // bounded however many matches there are, and once it has been cut a
    // match that ranks no better than the last row kept is dropped unseen
    // (a later arrival loses a tie, as it would in the stable sort).
    let kept: Array<{ key: RankKey; line: string }> = [];
    let worst: RankKey | undefined;
    const byKey = (a: { key: RankKey }, b: { key: RankKey }) => compareRankKeys(a.key, b.key);
    const relative = new Map<string, { path: string; band: number }>();
    let matched = 0;
    let errorOutput = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errorOutput = (errorOutput + chunk).slice(0, 64 * 1024);
    });
    lines.on("line", (line: string) => {
      const found = matchRankFields(line);
      if (!found) return;
      const inFile = (perFile.get(found.file) ?? 0) + 1;
      perFile.set(found.file, inFile);
      if (inFile > perFileCap) {
        capped = true;
        return;
      }
      matched++;
      if (limit <= 0) return;
      let file = relative.get(found.file);
      if (!file) {
        const rel = workspaceRelativePath(found.name, root);
        file = { path: rel, band: textResultPriority(rel) };
        relative.set(found.file, file);
      }
      const key: RankKey = { band: file.band, path: file.path, line: found.line, file: found.file };
      if (worst && compareRankKeys(key, worst) >= 0) return;
      kept.push({ key, line });
      if (kept.length >= limit * 2) {
        kept = keepTopK(kept, limit, byKey);
        worst = kept[kept.length - 1]?.key;
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      lines.close();
      // Drain through exit so errors after the retained matches are not hidden.
      if (code === 0 || code === 1) {
        resolve({ stdout: keepTopK(kept, limit, byKey).map((m) => m.line).join("\n"), matched, capped });
      } else {
        reject(Object.assign(new Error("ripgrep failed"), {
          code,
          signal,
          stderr: errorOutput,
        }));
      }
    });
  });
}

/**
 * `args` with its own `--max-count` (the one before `--`; anything after is
 * the caller's term and path) raised by one, and the cap it had. A cap of 0
 * or none at all is left as it is: there is nothing to tell apart.
 */
function probePerFileCap(args: string[]): { argv: string[]; perFileCap: number } {
  const separator = args.indexOf("--");
  const flags = separator >= 0 ? args.slice(0, separator) : args;
  const capIndex = flags.indexOf("--max-count");
  const cap = capIndex >= 0 ? Number(flags[capIndex + 1]) : NaN;
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    return { argv: args, perFileCap: Number.isFinite(cap) ? cap : Infinity };
  }
  const argv = [...args];
  argv[capIndex + 1] = String(cap + 1);
  return { argv, perFileCap: cap };
}

/**
 * What a match ranks by: band, then workspace-relative path, then line. `file`
 * is ripgrep's own name for the file (see `ripgrepPath`) and only breaks ties
 * between two files whose decoded paths are the same string.
 */
interface RankKey {
  band: number;
  path: string;
  line: number;
  file?: string;
}

function compareRankKeys(a: RankKey, b: RankKey): number {
  if (a.band !== b.band) return a.band - b.band;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  const fileA = a.file ?? "";
  const fileB = b.file ?? "";
  return fileA === fileB ? 0 : fileA < fileB ? -1 : 1;
}

/**
 * A path from a ripgrep `--json` record. ripgrep sends a path that is not
 * valid UTF-8 as `{"bytes": <base64>}` instead of `{"text": ...}`. `id` tells
 * files apart exactly (it keys the per-file `--max-count` count); `name` is
 * the path to show and rank by, with bytes that are not UTF-8 decoded to
 * U+FFFD. Reading only `text` gave every such file the name "", so they all
 * counted as one file and printed as the workspace root.
 */
function ripgrepPath(p: any): { id: string; name: string } {
  if (typeof p?.text === "string") return { id: `t:${p.text}`, name: p.text };
  if (typeof p?.bytes === "string") {
    return { id: `b:${p.bytes}`, name: Buffer.from(p.bytes, "base64").toString("utf8") };
  }
  return { id: "", name: "" };
}

// ripgrep's `--json` match records start with these fields in this order. A
// line that does not fit (a non-UTF-8 path arrives as `bytes`, say) falls back
// to a full parse; nothing is ranked on a guess.
const MATCH_HEAD = /^\{"type":"match","data":\{"path":\{"text":("(?:[^"\\]|\\.)*")\}/;
const LINE_NUMBER = /"line_number":(\d+)/;

/**
 * The path and line of a ripgrep `match` record, or undefined for any other
 * line. Most records are read with two regexes instead of a full JSON.parse:
 * ripgrep is drained to exit and every match is ranked, so on a dense term
 * the parse was most of the cost.
 */
function matchRankFields(line: string): { file: string; name: string; line: number } | undefined {
  const head = MATCH_HEAD.exec(line);
  const number = head ? LINE_NUMBER.exec(line) : null;
  if (head && number) {
    try {
      const { id, name } = ripgrepPath({ text: JSON.parse(head[1]) });
      return { file: id, name, line: Number(number[1]) };
    } catch {
      // fall through to the full parse
    }
  }
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed?.type !== "match") return undefined;
  const { id, name } = ripgrepPath(parsed.data?.path);
  return { file: id, name, line: parsed.data?.line_number ?? 0 };
}

/** A path ripgrep printed, relative to `root` with forward slashes. */
function workspaceRelativePath(filePath: string, root: string): string {
  const absoluteFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  return path.relative(root, absoluteFilePath).split(path.sep).join("/");
}

/** One ripgrep `match` record as a result, its path relative to `root` and its snippet clipped (clipSnippet). */
function textResultFromMatch(data: any, root: string): TextResult {
  const filePath = ripgrepPath(data?.path).name;
  const lineNum = data?.line_number ?? 0;
  return {
    path: workspaceRelativePath(filePath, root),
    line_start: lineNum,
    line_end: lineNum,
    snippet: clipSnippet(data?.lines?.text ?? "", data?.submatches),
    engine: "ripgrep",
    score: 1.0,
    language: inferLanguage(filePath),
  };
}

export function resolveTextSearchPath(root: string, searchPath: string): string {
  return path.resolve(root, searchPath);
}

/**
 * How far past `--limit` the scan looks before ranking.
 *
 * ripgrep walks the tree in directory order, so a plain `--limit 20` returns
 * the first twenty matches it happened to reach — which on this repo means
 * `docs/` and `README.md` before any code, because `d` and `R` sort early.
 * Ranking the twenty rows it already cut cannot fix that; the scan has to see
 * more than it prints. Bounded so a term matching everything is still one
 * cheap pass.
 *
 * The window is the best `scanWindow(limit, offset)` matches under
 * `compareTextResults`, taken over every match ripgrep finds — not the first
 * that many to arrive, which would differ between runs.
 *
 * `--offset` widens the window to look the same distance past the page as the
 * first page looks past its own, so paging is not stuck inside the first
 * page's window. The window is the top K of one total order, so a wider
 * window only appends rows: page N cut from a wide window is the page N a
 * narrow one would show. Pages line up while `--limit` stays fixed (it is
 * also ripgrep's per-file `--max-count`). The window still stops at
 * SCAN_WINDOW_MAX rows, and past that the output says to narrow.
 */
const SCAN_WINDOW_FACTOR = 5;
export const SCAN_WINDOW_MAX = 500;

export function scanWindow(limit: number, offset = 0): number {
  const ahead = Math.max(limit * SCAN_WINDOW_FACTOR, limit);
  return Math.min(Math.max(offset, 0) + ahead, SCAN_WINDOW_MAX);
}

const TEST_PATH = /(^|\/)(tests?|__tests__|fixtures?|testdata|spec)(\/|$)|\.(test|spec)\./i;
const PROSE_FILE = /\.(md|markdown|mdx|rst|txt|adoc)$/i;
const GENERATED_FILE = /(^|\/)(package-lock\.json|[^/]*\.lock|[^/]*\.sum)$/i;

/**
 * Code first, then tests and fixtures, then prose and lockfiles.
 *
 * `ix mcp` describes this command's output as "ranked hits" and it was not
 * ranked at all — it was ripgrep's traversal order. A README mentioning a
 * symbol is the weakest evidence of the three: it cannot be called, read as a
 * definition, or edited with any confidence. A test at least shows the symbol
 * in use.
 *
 * Only these three bands; within a band rows go by path and line (see
 * `compareTextResults`). The alternative — scoring by line content — guesses
 * at what the caller meant from a single grep term.
 */
export function textResultPriority(filePath: string): number {
  const normalized = filePath.split(path.sep).join("/");
  if (PROSE_FILE.test(normalized) || GENERATED_FILE.test(normalized)) return 2;
  if (TEST_PATH.test(normalized)) return 1;
  return 0;
}

/**
 * The total order `ix text` ranks by: band (`textResultPriority`), then path,
 * then line. Paths compare by code unit, not locale, so the order is the same
 * on every machine. Callers sort stably, so equal rows keep arrival order.
 */
export function compareTextResults(a: TextResult, b: TextResult): number {
  return compareRankKeys(
    { band: textResultPriority(a.path), path: a.path, line: a.line_start },
    { band: textResultPriority(b.path), path: b.path, line: b.line_start },
  );
}

export function registerTextCommand(program: Command, executeRipgrep?: RunRipgrep): void {
  program
    .command("text <term>")
    .description("Fast lexical/text search across the codebase (uses ripgrep)")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", OFFSET_FLAG, "0")
    .option("--path <dir>", "Restrict search to a workspace-relative directory", ".")
    .option("--language <lang>", "Filter by language (python, typescript, scala, etc.)")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--root <dir>", "Workspace root directory")
    .addHelpText("after", "\nExamples:\n  ix text verify_token --language python\n  ix text \"class.*Service\" --limit 10 --format json\n  ix text TODO --path src/\n  ix text TODO --offset 20")
    .action(async (
      term: string,
      opts: { limit: string; offset?: string; path: string; format: string; language?: string; root?: string },
      cmd: Command,
    ) => {
      const limit = parseInt(opts.limit, 10);
      const offset = parseOffset(opts.offset);
      const root = path.resolve(resolveWorkspaceRoot(opts.root));
      const searchPath = resolveTextSearchPath(root, opts.path);
      if (!isPathInsideResolvedRoot(root, searchPath)) {
        const message = `Search path is outside the workspace: ${opts.path}`;
        if (opts.format === "json") {
          printJson({ error: "path_outside_workspace", message });
        } else if (opts.format === "llm") {
          console.log(llmError("path_outside_workspace", message));
        } else {
          stderr(`Error: ${message}`);
        }
        process.exitCode = 1;
        return;
      }
      try {
        const window = scanWindow(limit, offset);
        const rgArgs = [
          "--json",
          // Per file, deliberately still `--limit`: one file monopolising the
          // scan window is the failure this is here to avoid.
          "--max-count", String(limit),
        ];

        if (opts.language) {
          for (const g of languageGlobs(opts.language)) {
            rgArgs.push("--glob", g);
          }
        }

        // `--` first. `term` reaches this argv verbatim from the caller, and
        // through `ix mcp` the caller is a model choosing the string, so
        // without the separator ripgrep parses any term beginning with `-` as
        // one of its own flags. `ix text --path=. --format=json -- --files`
        // ran rg's `--files` instead of searching for that literal, and a flag
        // that swallows the path argument -- `--pre=<cmd>`, `--file=<path>` --
        // leaves rg with no path to search, so it reads stdin and never
        // returns. `ix mcp` serialises its runs, so one such call blocks every
        // other tool until the timeout and leaves the child process behind.
        rgArgs.push("--", term, searchPath);

        const run: RunRipgrep = executeRipgrep ?? ((args, k) => runRipgrep(args, k, root));
        const { stdout, matched, capped } = await run(rgArgs, window);

        const results: TextResult[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "match") results.push(textResultFromMatch(parsed.data, root));
          } catch {
            // skip non-JSON lines
          }
        }

        // Sorted here as well as in the executor, so the order never depends
        // on which executor ran or how it delivered the rows. The window is
        // then ranked, and every page is a plain cut of it.
        results.sort(compareTextResults);
        const slice = sliceRanked(results.slice(0, window), limit, undefined, offset);
        if (slice.nextOffset !== undefined) slice.next = nextPageCommand(cmd, [term], slice.nextOffset);
        formatTextResults(slice, opts.format, { windowFull: (matched ?? results.length) > window || capped === true });
      } catch (err: any) {
        if (err.code === "ENOENT") {
          stderr("Error: ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep#installation");
          process.exit(1);
        }
        // rg exit 1 = no matches; render as empty result set
        if (err.code === 1 || err.status === 1) {
          formatTextResults(sliceRanked([] as TextResult[], limit, undefined, offset), opts.format);
          return;
        }
        // rg exit 2 = usage/regex error (e.g. literal "\n" in regex,
        // unbalanced escape). Surface rg's stderr verbatim so the caller
        // sees the actual cause instead of a raw Node stack.
        const rgStderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
        const firstLine = rgStderr.split("\n", 1)[0] ?? "";
        stderr(`Error: ripgrep failed${firstLine ? `: ${firstLine}` : ""}`);
        if (rgStderr && rgStderr !== firstLine) {
          stderr(rgStderr);
        }
        process.exit(1);
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
  if (filePath.endsWith(".tex") || filePath.endsWith(".sty") || filePath.endsWith(".cls")
    || filePath.endsWith(".ltx") || filePath.endsWith(".latex")) return "latex";
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
    case "latex": case "tex": return ["*.tex", "*.sty", "*.cls", "*.ltx", "*.latex"];
    case "config": return ["*.json", "*.yaml", "*.yml", "*.toml"];
    default: return [`*.${lang}`];
  }
}
