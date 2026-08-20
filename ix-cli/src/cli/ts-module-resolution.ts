import * as fs from "node:fs";
import * as nodePath from "node:path";
import { readBoundedFile } from "./bounded-read.js";

interface PathRule {
  pattern: string;
  targets: string[];
  baseDir: string;
}

interface LoadedConfig {
  dir: string;
  baseUrl?: string;
  paths: PathRule[];
}

export type TypeScriptModuleResolver = (
  sourcePath: string,
  specifier: string,
  kind?: "runtime" | "types",
) => string[] | undefined;

const SOURCE_SUFFIXES = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

function normalizePath(value: string): string {
  return nodePath.posix.normalize(value.replace(/\\/g, "/"));
}

function isWithinDir(filePath: string, dir: string): boolean {
  return dir === "." || filePath === dir || filePath.startsWith(`${dir}/`);
}

function toggleFirstAsciiCase(value: string): string | undefined {
  const index = value.search(/[A-Za-z]/);
  if (index === -1) return undefined;
  const char = value[index];
  const toggled = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
  return value.slice(0, index) + toggled + value.slice(index + 1);
}

function isCaseSensitiveFilesystem(workspaceRoot: string, absoluteFilePaths: string[]): boolean {
  for (const candidate of [...absoluteFilePaths, workspaceRoot]) {
    const basename = nodePath.basename(candidate);
    const toggled = toggleFirstAsciiCase(basename);
    if (!toggled || toggled === basename) continue;
    const alternate = nodePath.join(nodePath.dirname(candidate), toggled);
    try {
      return fs.realpathSync.native(candidate) !== fs.realpathSync.native(alternate);
    } catch {
      return true;
    }
  }
  return true;
}

function parseJsonc(text: string): unknown {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        output += "  ";
        blockComment = false;
        i += 1;
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      i += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      i += 1;
    } else {
      output += char;
    }
  }

  let normalized = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < output.length; i += 1) {
    const char = output[i];
    if (inString) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      normalized += char;
      continue;
    }
    if (char === ",") {
      let next = i + 1;
      while (/\s/.test(output[next] ?? "")) next += 1;
      if (output[next] === "}" || output[next] === "]") continue;
    }
    normalized += char;
  }

  return JSON.parse(normalized);
}

/**
 * True when the file we are *holding open* lives inside the workspace.
 *
 * The lexical check in {@link isWithinWorkspace} cannot see through a symlinked
 * directory: every segment of `./linked/tsconfig.json` is inside the workspace
 * by path arithmetic even when `linked/` points somewhere else entirely. Only
 * the resolved path shows that, so resolve it and re-check.
 *
 * Resolving the name a second time reopens the question of whether it still
 * denotes the file we hold, so the resolved path is confirmed to be the same
 * inode as the open handle. Without that, swapping the symlink between the open
 * and the resolve would let an outside file be read under an inside name.
 * (`ino` is 0 on filesystems that do not report one — chiefly some Windows
 * configurations — where this degrades to the plain resolved-path check.)
 *
 * The ROOT is resolved too, and that is not symmetry for its own sake: a
 * resolved file compared against an unresolved root rejects every config
 * whenever the workspace is itself reached through a link — macOS `/var` ->
 * `/private/var`, a home directory on a network mount, a `~/code` symlink. That
 * would silently switch tsconfig resolution off for those users, and no CI
 * runner here has a symlinked root to notice it.
 */
function openedWithinWorkspace(
  workspaceRoot: string,
  filePath: string,
  opened: fs.Stats,
): boolean {
  try {
    const resolved = fs.realpathSync(filePath);
    const viaResolved = fs.statSync(resolved);
    if (viaResolved.dev !== opened.dev || viaResolved.ino !== opened.ino) return false;
    let resolvedRoot: string;
    try {
      resolvedRoot = fs.realpathSync(workspaceRoot);
    } catch {
      resolvedRoot = workspaceRoot; // unreadable root: fall back to the lexical check
    }
    return isWithinWorkspace(resolvedRoot, resolved);
  } catch {
    return false;
  }
}

function readObject(workspaceRoot: string, filePath: string): Record<string, unknown> | undefined {
  // The FIFO-safe open, the regular-file check and the bound are shared with
  // the manifest readers — see bounded-read.ts, which also explains why the
  // size check alone does not bound the read. Containment stays here: the root
  // it is measured against is this caller's, and it runs on the same open
  // handle, before any content is read.
  const text = readBoundedFile(filePath, {
    accept: (stats) => openedWithinWorkspace(workspaceRoot, filePath, stats),
  });
  if (text === null) return undefined;
  try {
    const parsed = parseJsonc(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Candidate paths a relative `extends` may name, in TypeScript's own order.
 * Returns every candidate rather than probing with `existsSync`: the caller
 * reads each one and `readObject` already reports an unreadable file as
 * `undefined`, so there is no check-then-use window (CodeQL js/file-system-race).
 */
function resolveExtends(workspaceRoot: string, configPath: string, value: unknown): string[] {
  if (typeof value !== "string" || !value.startsWith(".")) return [];
  const unresolved = nodePath.resolve(nodePath.dirname(configPath), value);
  return [unresolved, `${unresolved}.json`, nodePath.join(unresolved, "tsconfig.json")].filter(
    // `startsWith(".")` is not containment: `nodePath.resolve` clamps at the
    // filesystem root, so "../../../../../../.." names any absolute path from
    // any depth. The config is repo content, so without this an ingested repo
    // chooses which files on the machine get read.
    (candidate) => isWithinWorkspace(workspaceRoot, candidate),
  );
}

function isWithinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(workspaceRoot), candidate);
  // Compare path *segments*: a bare `..startsWith` also rejects a legitimate
  // sibling directory whose name merely begins with dots, e.g. `..shared/`.
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relative)
  );
}

function loadConfig(
  workspaceRoot: string,
  configPath: string,
  cache: Map<string, LoadedConfig | undefined>,
  loading = new Set<string>(),
): LoadedConfig | undefined {
  const absoluteConfig = nodePath.resolve(configPath);
  if (cache.has(absoluteConfig)) return cache.get(absoluteConfig);
  if (loading.has(absoluteConfig)) return undefined;
  loading.add(absoluteConfig);

  const raw = readObject(workspaceRoot, absoluteConfig);
  if (!raw) {
    cache.set(absoluteConfig, undefined);
    loading.delete(absoluteConfig);
    return undefined;
  }

  const extendsCandidates = resolveExtends(workspaceRoot, absoluteConfig, raw.extends);
  let parent: LoadedConfig | undefined;
  for (const candidate of extendsCandidates) {
    parent = loadConfig(workspaceRoot, candidate, cache, loading);
    if (parent) break;
  }

  // A scoped run (`ix map ./packages/web`) roots containment at the ingest path,
  // so a monorepo's shared `tsconfig.base.json` one level up is dropped. Half-
  // loading what remains is worse than not loading it: this config's own `paths`
  // would still match, fail to resolve against the missing `baseUrl`, and return
  // an *authoritative* empty — which suppresses the stem fallback and deletes an
  // edge main resolves fine. Treat the config as unusable instead, which is
  // exactly main's behaviour.
  if (typeof raw.extends === "string" && raw.extends.startsWith(".") && !parent) {
    cache.set(absoluteConfig, undefined);
    loading.delete(absoluteConfig);
    return undefined;
  }
  const configDir = nodePath.dirname(absoluteConfig);
  const compilerOptions =
    raw.compilerOptions && typeof raw.compilerOptions === "object"
      ? (raw.compilerOptions as Record<string, unknown>)
      : {};
  const ownBaseUrl =
    typeof compilerOptions.baseUrl === "string"
      ? nodePath.resolve(configDir, compilerOptions.baseUrl)
      : undefined;
  const baseUrl = ownBaseUrl ?? parent?.baseUrl;
  let paths = parent?.paths ?? [];
  if (compilerOptions.paths && typeof compilerOptions.paths === "object") {
    const pathBase = baseUrl ?? configDir;
    paths = Object.entries(compilerOptions.paths as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string[]] =>
          Array.isArray(entry[1]) && entry[1].every((target) => typeof target === "string"),
      )
      .map(([pattern, targets]) => ({ pattern, targets, baseDir: pathBase }))
      .sort((a, b) => {
        const aStar = a.pattern.indexOf("*");
        const bStar = b.pattern.indexOf("*");
        if (aStar === -1 || bStar === -1) return aStar === -1 ? -1 : 1;
        return bStar - aStar;
      });
  }

  const relativeDir = normalizePath(nodePath.relative(workspaceRoot, configDir) || ".");
  const loaded = { dir: relativeDir, baseUrl, paths };
  cache.set(absoluteConfig, loaded);
  loading.delete(absoluteConfig);
  return loaded;
}

function matchPathPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === specifier ? "" : undefined;
  if (pattern.indexOf("*", star + 1) !== -1) return undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined;
}

export function createTypeScriptModuleResolver(
  workspaceRoot: string,
  absoluteFilePaths: string[],
  options: { caseSensitive?: boolean } = {},
): TypeScriptModuleResolver {
  const root = nodePath.resolve(workspaceRoot);
  const caseSensitive =
    options.caseSensitive ?? isCaseSensitiveFilesystem(root, absoluteFilePaths);
  const pathKey = (value: string): string => {
    const normalized = normalizePath(value);
    return caseSensitive ? normalized : normalized.toLowerCase();
  };
  const indexed = new Map(
    absoluteFilePaths.map((filePath) => {
      const relativePath = normalizePath(nodePath.relative(root, nodePath.resolve(filePath)));
      return [pathKey(relativePath), relativePath];
    }),
  );

  const resolveCandidate = (
    absoluteTarget: string,
    sourcePath: string,
    kind: "runtime" | "types",
  ): string[] => {
    const relativeTarget = normalizePath(nodePath.relative(root, absoluteTarget));
    const extension = nodePath.posix.extname(relativeTarget).toLowerCase();
    const base = extension ? relativeTarget.slice(0, -extension.length) : relativeTarget;
    const sourceExtension = nodePath.posix.extname(normalizePath(sourcePath)).toLowerCase();
    const preferJavaScript = [".js", ".jsx", ".mjs", ".cjs"].includes(sourceExtension);
    const extensionlessSuffixes =
      kind === "types"
        ? SOURCE_SUFFIXES
        : preferJavaScript
          ? [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".d.ts"]
          : [".ts", ".tsx", ".js", ".jsx", ".d.ts", ".mjs", ".cjs"];
    const candidates =
      extension === ".js"
        ? kind === "types"
          ? [base + ".ts", base + ".tsx", base + ".d.ts", relativeTarget, base + ".jsx"]
          : preferJavaScript
            ? [relativeTarget, base + ".jsx", base + ".ts", base + ".tsx", base + ".d.ts"]
            : [base + ".ts", base + ".tsx", relativeTarget, base + ".jsx", base + ".d.ts"]
        : extension === ".jsx"
          ? kind === "types"
            ? [base + ".tsx", base + ".d.ts", relativeTarget]
            : preferJavaScript
              ? [relativeTarget, base + ".tsx", base + ".d.ts"]
              : [base + ".tsx", relativeTarget, base + ".d.ts"]
          : extension
            ? [relativeTarget]
            : [
                ...extensionlessSuffixes.map((suffix) => relativeTarget + suffix),
                ...extensionlessSuffixes.map((suffix) =>
                  nodePath.posix.join(relativeTarget, "index" + suffix),
                ),
              ];
    const match = candidates.map((candidate) => indexed.get(pathKey(candidate))).find(Boolean);
    return match ? [match] : [];
  };

  const configCache = new Map<string, LoadedConfig | undefined>();
  const configs = absoluteFilePaths
    .filter((filePath) => /(?:^|[/\\])(?:tsconfig|jsconfig)\.json$/i.test(filePath))
    .map((filePath) => loadConfig(root, filePath, configCache))
    .filter((config): config is LoadedConfig => config !== undefined)
    .sort((a, b) => b.dir.length - a.dir.length);

  // Ingestion asks the same question repeatedly: resolution runs per bound
  // relationship, and index.ts issues two full lookups of the same triple for
  // each one. Only three things about a call change the answer — see the key.
  const resolutionCache = new Map<string, string[] | undefined>();

  const resolveUncached = (
    sourcePath: string,
    normalizedSource: string,
    specifier: string,
    kind: "runtime" | "types",
  ): string[] | undefined => {
    const config = configs.find((candidate) => isWithinDir(normalizedSource, candidate.dir));
    // Only an *explicit* `paths` mapping licenses an authoritative "no match".
    // A bare `baseUrl` — and a catch-all `"*"` rule, which is the same thing
    // spelled differently — matches `react` exactly as readily as `@app/thing`,
    // so treating its miss as authoritative would delete every third-party
    // import edge in any repo that sets one.
    let mappedExplicitly = false;
    if (config) {
      for (const rule of config.paths) {
        const star = matchPathPattern(rule.pattern, specifier);
        if (star === undefined) continue;
        for (const target of rule.targets) {
          const matches = resolveCandidate(
            nodePath.resolve(rule.baseDir, target.split("*").join(star)),
            sourcePath,
            kind,
          );
          if (matches.length > 0) return matches;
        }
        mappedExplicitly = rule.pattern !== "*";
        break;
      }
      // TypeScript tries `paths` first and then falls back to `baseUrl`, so a
      // failed rule must not short-circuit the baseUrl lookup.
      if (config.baseUrl) {
        const matches = resolveCandidate(
          nodePath.resolve(config.baseUrl, specifier),
          sourcePath,
          kind,
        );
        if (matches.length > 0) return matches;
      }
    }
    return mappedExplicitly ? [] : undefined;
  };

  return (sourcePath: string, rawSpecifier: string, kind = "runtime"): string[] | undefined => {
    const specifier = rawSpecifier.split(/[?#]/, 1)[0];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
    const normalizedSource = normalizePath(sourcePath);
    // Config selection reads only the source *directory*; candidate ordering
    // additionally reads the source *extension* (a .js caller prefers .js over
    // .ts). Nothing else about the path is consulted, so this key is exact —
    // keying on the directory alone would serve a .js caller's answer to a .ts
    // caller in the same folder and silently flip the preference order.
    const cacheKey = [
      nodePath.posix.dirname(normalizedSource),
      nodePath.posix.extname(normalizedSource).toLowerCase(),
      specifier,
      kind,
    ].join("\x00");
    if (resolutionCache.has(cacheKey)) return resolutionCache.get(cacheKey);
    const result = resolveUncached(sourcePath, normalizedSource, specifier, kind);
    resolutionCache.set(cacheKey, result);
    return result;
  };
}
