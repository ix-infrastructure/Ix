// Copyright 2026 Ix Infrastructure Inc.

/**
 * `ix read --format json`: every shape its answer can take.
 *
 * Fields are only added; see miss.ts for the compatibility rule. `ix read`'s
 * miss is the shared `unresolved_target` record (miss.ts), exit 3.
 */

import type { ResolutionNotice } from "../resolve.js";
import type { JsonDiagnostic } from "./miss.js";

/**
 * The source that was read (exit 0). `path` is workspace-relative in the
 * output; the command holds it absolute until it prints.
 */
export interface ReadJson {
  targetType: "file" | "file-range" | "filename-match" | "symbol";
  path: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  symbol?: string;
  kind?: string;
  stale?: boolean;
  warning?: string;
  /** Set when the default line cap stopped the read short of the file. */
  truncated?: boolean;
  /**
   * How many lines the read's whole target has, when the read was capped: the
   * file's line count for a file, and the span's line count (`spanEnd` minus
   * its first line, plus one) for a symbol or a paged range. It is a count,
   * never a line number; `spanEnd` is where a symbol or paged range ends.
   */
  totalLines?: number;
  /**
   * The last line of the symbol or paged range being paged, when the read was
   * capped. Absent on plain file reads, where `totalLines` is already the last
   * line.
   */
  spanEnd?: number;
  /**
   * The next page, ready to run. `path:401-800` for a file. For a symbol or a
   * paged range it is `path:<first>-<last>@<from>`: the same span, read from
   * `<from>` and capped again, so following it repeatedly reaches `spanEnd`.
   */
  next?: string;
  /** `"fuzzy"` when a symbol matched no name exactly; absent otherwise. */
  resolutionMode?: "fuzzy";
  /**
   * Present when a symbol read was a guess (a `fuzzy_match` notice, or an
   * `ambiguous_target` tie); same records as `ix locate`'s. The read still exits 0.
   */
  resolutionNotices?: ResolutionNotice[];
}
/**
 * A file or symbol name that matches several (exit 0, as it always has).
 *
 * EXCEPTION to the shared envelope: no `error` slug, and `targetType` says what
 * kind of ambiguity it is. It exits 0, and an `error` on an exit-0 answer reads
 * as a failure to the readers that key on it (#853), so moving it to
 * `ambiguous_target` waits for an owner decision. When it moves, `targetType`
 * stays for one deprecation period.
 */
export interface ReadAmbiguityJson {
  targetType: "ambiguous-file" | "ambiguous-symbol";
  /** 1-based `rank` is the `--pick <n>` that chooses the candidate. */
  candidates: Array<{ name: string; kind?: string; path?: string; id?: string; rank?: number; container?: string }>;
  diagnostics?: JsonDiagnostic[];
}

/** A refused read (exit 1): the plain failure envelope, `{error, message}`. */
export interface ReadFailureJson {
  error: "path_outside_workspace" | "invalid_line_range";
  message: string;
}
