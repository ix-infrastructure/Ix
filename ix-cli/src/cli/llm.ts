/**
 * Renderer for the `--format llm` output convention.
 *
 * The goal is a newline-delimited, token-minimal wire format that AI coding
 * agents (ix-claude-plugin, Cursor, Codex, ...) can consume without the
 * decorative whitespace of `--format text` or the structural overhead of
 * `--format json`. See docs/llm-format.md for the full spec.
 *
 * Convention:
 *   - One record per line. Newline-delimited, no nesting.
 *   - Scalars: `key=value` pairs separated by a single space.
 *   - Tabular rows: a leading record-kind token, then `key=value` pairs.
 *   - No decorative whitespace, separators, or headers.
 *   - Null/undefined/empty values are dropped. Zeros and other defaults are
 *     dropped by the caller where they carry no signal.
 *   - Quoting: a value containing a space, `=`, `"`, or a control character is
 *     wrapped in double quotes; inner `"` and `\` are backslash-escaped and
 *     newlines/tabs are encoded as `\n`/`\r`/`\t` so a record never spans lines.
 */

/** A field value before rendering. Nullish/empty values are omitted. */
export type LlmValue = string | number | boolean | null | undefined;

/** Ordered field pairs, or a plain object whose own enumerable keys are used. */
export type LlmFields = Array<[string, LlmValue]> | Record<string, LlmValue>;

// Quote when a value contains whitespace, `=`, `"`, `\`, or any C0 control char.
const NEEDS_QUOTING = /[\s="\\\x00-\x1f]/;

/**
 * Quote and escape a value for the llm wire format.
 *
 * Bare values pass through untouched. Anything containing whitespace, `=`, `"`,
 * or a control character is wrapped in double quotes with `\` and `"` escaped
 * and newline/CR/tab encoded so the value stays on a single line.
 */
export function llmQuote(raw: string): string {
  if (raw === "") return '""';
  if (!NEEDS_QUOTING.test(raw)) return raw;
  const escaped = raw
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Render a single `key=value` token, or null if the value is omitted. */
export function llmField(key: string, value: LlmValue): string | null {
  if (value === null || value === undefined) return null;
  const str = typeof value === "string" ? value : String(value);
  if (str === "") return null;
  return `${key}=${llmQuote(str)}`;
}

function fieldEntries(fields: LlmFields): Array<[string, LlmValue]> {
  return Array.isArray(fields) ? fields : Object.entries(fields);
}

/**
 * Render one record line: an optional leading record-kind token followed by
 * `key=value` pairs. Omitted fields (nullish/empty) are skipped. Returns the
 * line without a trailing newline.
 */
export function llmLine(recordKind: string | null, fields: LlmFields = []): string {
  const parts: string[] = [];
  if (recordKind) parts.push(recordKind);
  for (const [key, value] of fieldEntries(fields)) {
    const field = llmField(key, value);
    if (field) parts.push(field);
  }
  return parts.join(" ");
}

/** Render an error record in the shared format. Caller still sets the exit code. */
export function llmError(
  code: string,
  message: string,
  extra: LlmFields = [],
): string {
  return llmLine("error", [["code", code], ["message", message], ...fieldEntries(extra)]);
}

/** Print rendered lines, skipping any that are empty. */
export function printLlmLines(lines: Array<string | null | undefined>): void {
  for (const line of lines) {
    if (line) console.log(line);
  }
}
