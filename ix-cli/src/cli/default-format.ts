// Copyright 2026 Ix Infrastructure Inc.

/**
 * Where the default `--format` comes from when a command is not given one.
 *
 * Every renderer costs a different number of tokens for the same answer —
 * `context` measured at roughly 7.6 : 0.8 : 1 for json : llm : text — so the
 * format an agent gets by default is one of the larger levers on what Ix costs
 * it. Until now the only way to move it was to append `--format llm` to every
 * call, which every plugin has to remember on every command it wraps.
 *
 * Resolution order: the flag on the command line, then `IX_FORMAT`, then
 * `format` in `~/.ix/config.yaml`, then `text`. The flag is commander's job;
 * this module supplies the rest as the option's default value, so `--format`
 * still wins wherever it appears and nothing here can override an explicit
 * choice.
 *
 * Deliberately *not* here: switching on whether stdout is a terminal. A script
 * that has always parsed text output would start receiving json on its next
 * run, which is a break with no opt-out.
 */

/** The formats every `--format` option accepts. */
export const DEFAULT_FORMAT_CHOICES = ["text", "json", "llm"] as const;

/** What a `--format` option falls back to when nothing is configured. */
export const BUILT_IN_DEFAULT_FORMAT = "text";

export interface ResolvedDefaultFormat {
  /** The format to use when no `--format` flag is given. */
  format: string;
  /**
   * A configured value that was not a format, and was therefore ignored.
   * Reported so a typo does not silently leave the caller on `text`.
   */
  ignored?: { source: "IX_FORMAT" | "config.format"; value: string };
}

/**
 * Resolve the default format from the environment and the stored config.
 *
 * An unrecognised value is ignored rather than fatal: `IX_FORMAT` is set once
 * in a shell profile or a plugin's launcher and read by every later command, so
 * a typo there would otherwise break every invocation of the CLI at once.
 */
export function resolveDefaultFormat(
  env: NodeJS.ProcessEnv,
  readConfigFormat: () => string | undefined,
): ResolvedDefaultFormat {
  let ignored: ResolvedDefaultFormat["ignored"];

  // `readConfigFormat` is a thunk so that a valid IX_FORMAT answers without
  // reading config.yaml off disk — this runs during registration, on every
  // invocation of the CLI, including `ix --help`.
  const sources: { source: "IX_FORMAT" | "config.format"; read: () => string | undefined }[] = [
    { source: "IX_FORMAT", read: () => env.IX_FORMAT },
    { source: "config.format", read: readConfigFormat },
  ];

  for (const { source, read } of sources) {
    const raw = read();
    const normalized = raw?.trim().toLowerCase();
    if (!normalized) continue;
    if (isFormat(normalized)) return { format: normalized, ...(ignored ? { ignored } : {}) };
    // Keep the first bad value: it is the more specific of the two, and one
    // line of warning is all this is worth.
    ignored ??= { source, value: raw as string };
  }

  return { format: BUILT_IN_DEFAULT_FORMAT, ...(ignored ? { ignored } : {}) };
}

export function isFormat(value: string): boolean {
  return (DEFAULT_FORMAT_CHOICES as readonly string[]).includes(value);
}
