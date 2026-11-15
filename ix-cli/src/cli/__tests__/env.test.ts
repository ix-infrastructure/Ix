// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import {
  ENV_VARS,
  envFlag,
  envNumber,
  flagValue,
  numberValue,
  parseFlag,
  parseNumber,
  type EnvSpec,
  type FlagName,
  type NumberName,
} from "../env.js";
import { TRANSIENT_RETRY_BUDGET_MS } from "../commit-retry.js";
import { MAX_WAIT_SECONDS } from "../options.js";
import { DEFAULT_FORMAT_CHOICES } from "../default-format.js";

describe("parseFlag: the one flag parser (#948)", () => {
  it("is undefined for unset, empty or all-space", () => {
    for (const raw of [undefined, "", "   "]) expect(parseFlag(raw), String(raw)).toBeUndefined();
  });

  it("is off for 0, false, no, n and off, in any case and with spaces around", () => {
    for (const raw of ["0", "false", "no", "n", "off", "FALSE", "No", "OFF", " 0 ", "\tfalse\n"]) expect(parseFlag(raw), raw).toBe(false);
  });

  it("is on for 1, true, yes, y and on, in any case and with spaces around", () => {
    for (const raw of ["1", "true", "yes", "y", "on", "TRUE", "On", " 1 "]) expect(parseFlag(raw), raw).toBe(true);
  });

  it("is undefined (the default) for any other value, so a word meant as off never turns a flag on", () => {
    for (const raw of ["2", "00", "enabled", "disabled", "none", "nope", "abc"]) expect(parseFlag(raw), raw).toBeUndefined();
    // Flags whose old reader took only `1`: none of these may switch them on.
    for (const raw of ["off", "n", "disabled", "none"]) {
      expect(flagValue("IX_DEBUG", raw), raw).toBe(false);
      expect(flagValue("IX_AUTO_MAP", raw), raw).toBe(false);
      expect(flagValue("IX_RECONCILE_ON_FORCE", raw), raw).toBe(false);
    }
    // IX_BULK_DELETES: `off` forces the old route; an unknown word leaves it to the backend's release.
    expect(flagValue("IX_BULK_DELETES", "off")).toBe(false);
    expect(flagValue("IX_BULK_DELETES", "disabled")).toBeUndefined();
    expect(flagValue("IX_BULK_DELETES", "2")).toBeUndefined();
    // A default-on flag stays on for an unknown word.
    expect(flagValue("IX_GRAPH_HEALTH", "disabled")).toBe(true);
    expect(flagValue("IX_GRAPH_HEALTH", "off")).toBe(false);
  });

  it("gives a flag its default when unset, and a third state when the default is unset", () => {
    expect(flagValue("IX_DEBUG", undefined)).toBe(false);
    expect(flagValue("IX_GRAPH_HEALTH", undefined)).toBe(true);
    expect(flagValue("IX_GRAPH_HEALTH", "")).toBe(true);
    expect(flagValue("IX_BULK_DELETES", undefined)).toBeUndefined();
    expect(flagValue("IX_BULK_DELETES", "0")).toBe(false);
    expect(envFlag("IX_DEBUG", { IX_DEBUG: "true" })).toBe(true);
  });
});

describe("parseNumber: the one number parser (#948)", () => {
  const ms = { type: "ms", zero: true } as const;
  const int = { type: "int", zero: true } as const;

  it("reads a whole decimal number in full, spaces around ignored", () => {
    expect(parseNumber("250", int)).toBe(250);
    expect(parseNumber(" 250 ", int)).toBe(250);
    expect(parseNumber("1e3", int)).toBe(1000);
    expect(parseNumber("1e3", ms)).toBe(1000);
    expect(parseNumber("1000.0", ms)).toBe(1000);
    expect(parseNumber("+5", ms)).toBe(5);
  });

  it("rejects hex, octal, binary, Infinity and fractions, which Number() alone would take", () => {
    for (const raw of ["0x10", "0X10", "0o17", "0b1", "0x0", "Infinity", "0.5", "2.5", "1e-9", ".5"]) {
      expect(parseNumber(raw, ms), raw).toBeUndefined();
      expect(parseNumber(raw, int), raw).toBeUndefined();
    }
  });

  it("never lets a hex or fractional value shrink a lock age, a deadline or the commit cutoff", () => {
    for (const raw of ["0.5", "0x10", "0b1", "1e-9"]) {
      expect(numberValue("IX_MAP_LOCK_MAX_MS", raw), raw).toBe(20 * 60 * 1000);
      expect(numberValue("IX_MAP_DEADLINE_MS", raw), raw).toBe(15 * 60 * 1000);
      expect(numberValue("IX_COMMIT_FAILURE_LIMIT", raw), raw).toBe(5);
    }
    expect(numberValue("IX_COMMIT_FAILURE_LIMIT", "0x0")).toBe(5);
  });

  it("reads an int too large to write as the most there can be, not as the default", () => {
    expect(numberValue("IX_COMMIT_FAILURE_LIMIT", "9".repeat(400))).toBe(Number.MAX_SAFE_INTEGER);
    expect(numberValue("IX_COMMIT_FAILURE_LIMIT", "1e400")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseNumber("1e400", ms)).toBeUndefined();
  });

  it("never reads a numeric prefix", () => {
    for (const raw of ["15m", "2k", "10ms", "1e3x", "abc"]) expect(parseNumber(raw, ms), raw).toBeUndefined();
  });

  it("rejects a negative value, and a fraction for an int", () => {
    expect(parseNumber("-1", ms)).toBeUndefined();
    expect(parseNumber("2.5", int)).toBeUndefined();
    expect(parseNumber("0.5", int)).toBeUndefined();
  });

  it("reads empty as the rule's empty value, else as unset", () => {
    expect(parseNumber("", ms)).toBeUndefined();
    expect(parseNumber("  ", ms)).toBeUndefined();
    expect(parseNumber("", { ...ms, empty: 0 })).toBe(0);
    expect(parseNumber(undefined, { ...ms, empty: 0 })).toBeUndefined();
  });

  it("reads 0 as 0 only where 0 is a value", () => {
    expect(parseNumber("0", ms)).toBe(0);
    expect(parseNumber("0", { ...ms, zero: false })).toBeUndefined();
  });

  it("clamps or rejects past the most a variable takes", () => {
    expect(parseNumber("301", { type: "int", zero: false, max: 300, clamp: true })).toBe(300);
    expect(parseNumber("256", { type: "int", zero: false, max: 255 })).toBeUndefined();
    expect(parseNumber("99999999999999999999", int)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("falls back to the registered default", () => {
    expect(numberValue("IX_COMMIT_CONCURRENCY", undefined)).toBe(8);
    expect(numberValue("IX_COMMIT_CONCURRENCY", "0")).toBe(8);
    expect(numberValue("IX_COMMIT_CONFLICT_RETRIES", "0")).toBe(0);
    expect(numberValue("IX_SMELLS_WAIT", undefined)).toBeUndefined();
    expect(envNumber("IX_STITCH_COOLDOWN_MS", { IX_STITCH_COOLDOWN_MS: "15m" })).toBe(15 * 60 * 1000);
  });
});

describe("the registry", () => {
  const entries = Object.entries(ENV_VARS) as [string, EnvSpec][];

  it("gives every variable a type, a one-line description and a visibility", () => {
    for (const [name, spec] of entries) {
      expect(["flag", "int", "ms", "string", "enum"], name).toContain(spec.type);
      expect(spec.description.trim(), name).not.toBe("");
      expect(spec.description, name).not.toMatch(/\n/);
      expect(["public", "internal"], name).toContain(spec.visibility);
    }
  });

  it("agrees with the constants other modules keep for the same settings", () => {
    expect(ENV_VARS.IX_COMMIT_TRANSIENT_RETRY_MS.default).toBe(TRANSIENT_RETRY_BUDGET_MS);
    expect(ENV_VARS.IX_SMELLS_WAIT.max).toBe(MAX_WAIT_SECONDS);
    expect([...ENV_VARS.IX_FORMAT.values]).toEqual([...DEFAULT_FORMAT_CHOICES]);
  });
});

// ---------------------------------------------------------------------------
// No behaviour change for values that work today (#948).
//
// Each reader below is the one the CLI had before the registry, copied as it
// was. For every value that did something (gave other than the unset result),
// the shared parser must give the same. Values that did nothing may now work:
// where the old rules differed, the registry takes their union.
// ---------------------------------------------------------------------------

type Old = (raw: string | undefined) => unknown;

const digitsPositive = (fallback: number): Old => (raw) => {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : fallback;
};
const digitsNonNegative = (fallback: number): Old => (raw) => {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const trimmedPositiveInt = (fallback: number): Old => (raw) => {
  const t = raw?.trim();
  if (!t || !/^\d+$/.test(t)) return fallback;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const trimmedNonNegativeInt = (fallback: number): Old => (raw) => {
  const t = raw?.trim();
  if (!t || !/^\d+$/.test(t)) return fallback;
  const n = Number.parseInt(t, 10);
  return Number.isSafeInteger(n) ? n : fallback;
};
const numberNonNegative = (fallback: number): Old => (raw) => {
  const t = raw?.trim();
  if (!t) return fallback;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const numberPositive = (fallback: number): Old => (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const isOne: Old = (raw) => raw === "1";
const notZero: Old = (raw) => raw !== "0";

const OLD_NUMBERS: Record<string, Old> = {
  IX_CONFIG_LOCK_WAIT_MS: digitsPositive(30_000),
  IX_CONFIG_LOCK_STALE_MS: digitsPositive(30_000),
  IX_STITCH_COOLDOWN_MS: digitsNonNegative(15 * 60 * 1000),
  IX_STITCH_WAIT_MS: digitsNonNegative(30 * 1000),
  IX_MAP_LOCK_MAX_MS: digitsPositive(20 * 60 * 1000),
  IX_READ_DEADLINE_MS: numberNonNegative(60_000),
  IX_STDIN_IDLE_MS: numberNonNegative(5 * 60_000),
  IX_PARSE_BUDGET_MS: numberNonNegative(10_000),
  IX_ORPHAN_SWEEP_MAX_MS: numberNonNegative(60_000),
  IX_ORPHAN_SWEEP_MAX_REQUESTS: numberNonNegative(25_000),
  IX_GRAPH_HEALTH_TIMEOUT_MS: numberPositive(2000),
  IX_HOOK_TIMEOUT_MS: numberPositive(3000),
  IX_PARSE_STREAM_CHUNK: trimmedPositiveInt(500),
  IX_COMMIT_HTTP_MAX_FILES: trimmedPositiveInt(1000),
  IX_COMMIT_MAX_OPS: trimmedPositiveInt(45_000),
  IX_COMMIT_CONCURRENCY: trimmedPositiveInt(8),
  IX_COMMIT_BASE_REV_RETRIES: trimmedPositiveInt(8),
  IX_COMMIT_CONFLICT_RETRIES: trimmedNonNegativeInt(6),
  IX_COMMIT_TRANSIENT_RETRY_MS: trimmedNonNegativeInt(5000),
  IX_PARSE_WORKERS: (raw) => {
    const n = Number(raw);
    return raw !== undefined && Number.isInteger(n) && n > 0 ? n : 8;
  },
  IX_MAP_DEADLINE_MS: (raw) => {
    if (raw === undefined) return 15 * 60 * 1000;
    const t = raw.trim();
    if (t !== "" && !/^\d+$/.test(t)) return 15 * 60 * 1000;
    const n = Number.parseInt(t, 10);
    return !Number.isFinite(n) || n <= 0 ? 0 : n; // 0: disabled (undefined, in mapDeadlineMs)
  },
  IX_MAP_REFRESH_DEBOUNCE_MS: (raw) => {
    if (raw === undefined) return 30_000;
    const t = raw.trim();
    if (t === "") return 0;
    return /^\d+$/.test(t) ? Number.parseInt(t, 10) : 30_000;
  },
  IX_MAP_DEBOUNCE_SECONDS: (raw) => {
    const t = raw?.trim();
    return t !== undefined && /^\d+$/.test(t) ? Number(t) : 300;
  },
  IX_MAP_BACKGROUND_TIMEOUT_MS: (raw) => {
    if (raw === undefined || !/^\d+$/.test(raw.trim())) return 5 * 60 * 1000;
    const n = Number.parseInt(raw.trim(), 10);
    return n > 0 ? n : 5 * 60 * 1000;
  },
  IX_COMMIT_FAILURE_LIMIT: (raw) => {
    if (raw === undefined || raw === "") return 5;
    if (!/^\d+$/.test(raw.trim()) || raw.trim() !== raw) return 5;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
  },
  IX_MAP_COALESCE_EXIT_CODE: (raw) => {
    if (raw === undefined) return undefined;
    const code = Number(raw);
    return Number.isInteger(code) && code >= 1 && code <= 255 ? code : undefined;
  },
  IX_SMELLS_WAIT: (raw) => {
    const t = raw?.trim();
    return t && /^\d+$/.test(t) && Number(t) > 0 && Number.isSafeInteger(Number(t)) ? Math.min(Number(t), 300) : undefined;
  },
};

const envSwitch: Old = (raw) => {
  const v = raw?.trim().toLowerCase();
  return !!v && v !== "0" && v !== "false" && v !== "no";
};
const isTruthyEnv: Old = (raw) => {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
};

const OLD_FLAGS: Record<string, Old> = {
  IX_STRICT_TARGETS: envSwitch,
  IX_LEGACY_EXIT_CODES: envSwitch,
  IX_NO_UPDATE_CHECK: isTruthyEnv,
  IX_DEBUG: isOne,
  IX_HOOK_DEBUG: isOne,
  IX_MCP_CHILD: isOne,
  IX_MCP_SUBPROCESS: isOne,
  IX_AUTO_MAP: isOne,
  IX_AUTO_MAP_CLOUD: isOne,
  IX_MAP_EAGER: isOne,
  IX_MAP_FULL_INGEST: isOne,
  IX_RECONCILE_ON_FORCE: isOne,
  IX_LOAD_ALL_COMMANDS: isOne,
  IX_GRAPH_HEALTH: notZero,
  IX_MISS_PROBE: notZero,
  IX_MAP_BACKGROUND_REFRESH: (raw) => raw === undefined || raw.trim() !== "0",
  IX_BULK_DELETES: (raw) => (raw === "1" ? true : raw === "0" ? false : undefined),
};

/**
 * Values that worked one way before and now work another, on purpose:
 * - `IX_NO_UPDATE_CHECK=no` was ON (its parser alone did not treat `no` as
 *   off); the issue names it as the inconsistency to remove.
 * - For the three flags whose old reader took any value but 0/false(/no) as
 *   on (IX_STRICT_TARGETS, IX_LEGACY_EXIT_CODES, IX_NO_UPDATE_CHECK), `off`
 *   and `n` are now off, and a value outside the on and off words (`2`, `00`,
 *   `abc`) now keeps the default.
 *   Their docs only ever said `=1`; reading unknown words as on is what let
 *   `IX_DEBUG=off` switch debugging on.
 * - A fraction (`1.5`) or a hex value (`0x10`) for a number whose old reader
 *   used Number(); the shared parser takes whole decimal numbers only, as
 *   the old digits-only readers did.
 */
const ANY_VALUE_ON = new Set(["IX_STRICT_TARGETS", "IX_LEGACY_EXIT_CODES", "IX_NO_UPDATE_CHECK"]);
function changedOnPurpose(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  if (name === "IX_NO_UPDATE_CHECK" && raw.trim().toLowerCase() === "no") return true;
  if (ANY_VALUE_ON.has(name)) return parseFlag(raw) !== true;
  if (name in OLD_NUMBERS) {
    const t = raw.trim();
    return /^0[xob]/i.test(t) || (t !== "" && !Number.isInteger(Number(t)));
  }
  return false;
}

const CORPUS = [
  "", " ", "0", " 0 ", "00", "1", " 1 ", "2", "5", "7", "250", "300", "301", "1000", "1e3", "1E3", "0x10",
  "1.5", "0.5", "1.0", "+5", "-1", "-0", "15m", "2k", "abc", "Infinity", "99999999999999999999",
  "true", "TRUE", "false", "no", "No", " no ", "yes", "on", "off", "n", "y", "disabled", "none",
];

/** Equal (-0 is 0), counting two ints past MAX_SAFE_INTEGER as the same "as many as there can be". */
const same = (a: unknown, b: unknown) =>
  a === b || (typeof a === "number" && typeof b === "number" && a >= Number.MAX_SAFE_INTEGER && b >= Number.MAX_SAFE_INTEGER);

describe("no behaviour change for values that work today (#948)", () => {
  it("covers every flag and number read through env.ts", () => {
    const parsed = Object.entries(ENV_VARS)
      .filter(([name, spec]) => spec.type !== "string" && spec.type !== "enum" && name !== "IX_PARSE_DEBUG" && name !== "IX_VIEW_PROXY_TIMEOUT_MS")
      .map(([name]) => name)
      .sort();
    expect(Object.keys({ ...OLD_NUMBERS, ...OLD_FLAGS }).sort()).toEqual(parsed);
  });

  it.each(Object.keys(OLD_NUMBERS))("%s", (name) => {
    const old = OLD_NUMBERS[name];
    for (const raw of CORPUS) {
      if (same(old(raw), old(undefined)) || changedOnPurpose(name, raw)) continue;
      expect(numberValue(name as NumberName, raw), `${name}=${JSON.stringify(raw)}`).toSatisfy((v: unknown) => same(v, old(raw)));
    }
    expect(numberValue(name as NumberName, undefined)).toBe(old(undefined));
  });

  it.each(Object.keys(OLD_FLAGS))("%s", (name) => {
    const old = OLD_FLAGS[name];
    for (const raw of CORPUS) {
      if (old(raw) === old(undefined) || changedOnPurpose(name, raw)) continue;
      expect(flagValue(name as FlagName, raw), `${name}=${JSON.stringify(raw)}`).toBe(old(raw));
    }
    expect(flagValue(name as FlagName, undefined)).toBe(old(undefined));
  });

  it("IX_DEBUG=true now turns debugging on, and IX_NO_UPDATE_CHECK=no no longer turns the check off", () => {
    expect(flagValue("IX_DEBUG", "true")).toBe(true);
    expect(flagValue("IX_NO_UPDATE_CHECK", "no")).toBe(false);
    expect(flagValue("IX_STRICT_TARGETS", "no")).toBe(false);
  });
});
