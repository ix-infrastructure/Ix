// Copyright 2026 Ix Infrastructure Inc.

/**
 * Where a name-matched candidate comes from, for ranking a code definition
 * above everything else that merely shares its name.
 *
 * Both `ix search` and the entity resolver behind `context` / `explain` /
 * `locate` match on names, and a name is shared by far more than its
 * definition:
 *
 * - **import** — every `import x from './x'` becomes a single-line `module`
 *   entity named after the specifier stem, located in the IMPORTING file
 *   (core-ingestion `index.ts`, the `import.source` / `import.name` captures).
 *   It is a reference, not a definition, but as a `module` it used to get the
 *   container boost and outrank the definition itself.
 * - **non-code** — CSS class/id selectors arrive as `class`, keyframes as
 *   `constant`, markdown headings as `heading`/`section`, JSON/YAML/TOML keys
 *   as `config_entry`/`config`. For a term that looks like a code identifier
 *   these are almost never what the caller meant.
 * - **generated** — copies of the definition in build output (`dist/`,
 *   `*.min.js`, `*-output.*`) and stand-ins in fixtures and samples.
 *
 * All three are demoted, never dropped: when nothing better matched they are
 * still the answer.
 */

import type { GraphKind, KindSet } from "./graph-model.js";

type CandidateOrigin = "definition" | "import" | "non-code" | "generated";

/** `attrs.language` values core-ingestion gives to markup, style and data files. */
const NON_CODE_LANGUAGES = new Set([
  "css", "scss", "sass", "less", "markdown", "json", "yaml", "toml",
  "html", "xml", "latex",
]);

/** Extensions for the same, for nodes that carry no `language` attribute. */
const NON_CODE_EXTENSIONS = new Set([
  ".css", ".scss", ".sass", ".less", ".styl",
  ".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc",
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".lock",
  ".html", ".htm", ".xml", ".svg", ".tex",
]);

/** Kinds core-ingestion emits only for docs and config, never for code. */
const NON_CODE_KINDS: KindSet = new Set<GraphKind>(["heading", "section", "config_entry", "config"]);

/**
 * Build output and other derived copies of source.
 *
 * Not `build/`. In a git repository `ix map` ingests only tracked files, so
 * gitignored build output never reaches the graph (and the filesystem walk
 * skips `build/` outright). What does arrive under `build/` is committed
 * source: Go's `src/go/build`, VS Code's `build/lib`, Next.js's
 * `packages/next/src/build`, pip's `operations/build`. Demoting it put every
 * import of a name ahead of its only definition.
 */
const GENERATED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(dist|generated|__generated__|node_modules)\//,
  /\.min\.[a-z0-9]+$/,
  /\.bundle\.[a-z0-9]+$/,
  /[-_.]output\.[a-z0-9]+$/,
];

/** Test fixtures and sample/demo code: stand-ins, not the definition. */
const FIXTURE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(fixtures?|__fixtures__|__mocks__|testdata|samples?)\//,
  /(^|\/)[^/]*fixture[^/]*$/,
];

/** Roles core-ingestion's role-classifier assigns to derived or stand-in files. */
const DEMOTED_ROLES = new Set(["generated", "fixture"]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*$/;
const FILE_NAME = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|scala|cs|php|swift|c|h|cc|cpp|hpp|css|scss|less|md|mdx|json|ya?ml|toml|html?|xml|txt)$/i;

/**
 * True for a term shaped like a code identifier: `flex`, `borderStylesReset`,
 * `TypeScript`, `Foo.bar`, `Foo::bar`, `$scope`. A term with a hyphen, a space
 * or a file extension (`border-solid`, `Getting Started`, `package.json`) is
 * more likely aimed at a selector, a heading or a file, so non-code matches
 * are left alone for it.
 */
export function looksLikeCodeIdentifier(term: string): boolean {
  return IDENTIFIER.test(term) && !FILE_NAME.test(term);
}

/**
 * True when the caller asked for non-code by name (`--kind heading`,
 * `--language css`): the demotion would then work against the request.
 */
export function requestsNonCode(opts?: { kind?: string; language?: string }): boolean {
  return (!!opts?.kind && NON_CODE_KINDS.has(opts.kind.toLowerCase()))
    || (!!opts?.language && (NON_CODE_LANGUAGES.has(opts.language.toLowerCase())
      || NON_CODE_EXTENSIONS.has(`.${opts.language.toLowerCase().replace(/^\./, "")}`)));
}

function sourcePath(node: any): string {
  return String(node?.provenance?.sourceUri ?? node?.provenance?.source_uri ?? node?.attrs?.file_uri ?? "")
    .toLowerCase()
    .replace(/\\/g, "/");
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/**
 * An import entity: a `module` that spans a single line. A module that is
 * really defined here (Ruby `module`, Elixir `defmodule`, a TS `namespace`)
 * spans its body and stays a definition.
 */
function isImportEntity(node: any): boolean {
  if ((node?.kind ?? "").toLowerCase() !== "module") return false;
  const start = node?.attrs?.line_start;
  const end = node?.attrs?.line_end;
  return typeof start === "number" && typeof end === "number" && start === end;
}

function isNonCodeNode(node: any): boolean {
  const kind = (node?.kind ?? "").toLowerCase();
  if (NON_CODE_KINDS.has(kind)) return true;
  const language = String(node?.attrs?.language ?? "").toLowerCase();
  if (language) return NON_CODE_LANGUAGES.has(language);
  return NON_CODE_EXTENSIONS.has(extensionOf(sourcePath(node)));
}

function isGeneratedOrFixture(node: any): boolean {
  if (DEMOTED_ROLES.has(String(node?.attrs?.role ?? ""))) return true;
  const path = sourcePath(node);
  if (!path) return false;
  return GENERATED_PATH_PATTERNS.some((p) => p.test(path))
    || FIXTURE_PATH_PATTERNS.some((p) => p.test(path));
}

/**
 * Classify a candidate. Precedence: generated first (a CSS selector in
 * `tailwind-output.css` is build output before it is CSS), then import, then
 * non-code.
 */
export function candidateOrigin(node: any): CandidateOrigin {
  if (isGeneratedOrFixture(node)) return "generated";
  if (isImportEntity(node)) return "import";
  if (isNonCodeNode(node)) return "non-code";
  return "definition";
}

/**
 * The file-name stem of a `file` node: `borderStylesReset.js` →
 * `borderstylesreset` (one extension only, so `x.test.js` is not a stem
 * match for `x`). A module that is one anonymous default export has no
 * symbol of its own name — its file IS the definition — so a file whose stem
 * equals the term is a name match, not the partial match the backend scores it
 * as.
 */
function fileStem(node: any): string | undefined {
  if ((node?.kind ?? "").toLowerCase() !== "file") return undefined;
  const name = String(node?.name ?? node?.attrs?.name ?? "");
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase() || undefined;
}

export function isFileStemMatch(node: any, term: string): boolean {
  const stem = fileStem(node);
  return stem !== undefined && stem === term.toLowerCase();
}
