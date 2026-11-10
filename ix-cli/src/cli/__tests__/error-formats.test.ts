// Copyright 2026 Ix Infrastructure Inc.

import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CliResolutionError, CliUsageError, WorkspaceNotMappedError,
  detectRequestedFormat, renderCliError, setErrorFormat,
} from "../errors.js";
import { readConfiguredFormat } from "../config.js";

vi.mock("../config.js", () => ({ readConfiguredFormat: vi.fn() }));

beforeEach(() => {
  vi.mocked(readConfiguredFormat).mockReset();
  vi.stubEnv("IX_FORMAT", "");
});

afterEach(() => {
  setErrorFormat(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const failures = [
  { kind: "usage", code: "usage_error", error: () => new CliUsageError("Bad flag", "Try --help") },
  { kind: "commander", code: "usage_error", error: () => new CommanderError(1, "commander.unknownOption", "error: unknown option '--bogus'") },
  { kind: "resolution", code: "resolution_failed", error: () => new CliResolutionError("No target", "Try ix locate") },
  { kind: "unmapped", code: "workspace_not_mapped", exit: 4, error: () => new WorkspaceNotMappedError("/repo", "Run ix map") },
  { kind: "legacy unmapped", code: "workspace_not_mapped", exit: 1, legacy: true, error: () => new WorkspaceNotMappedError("/repo", "Run ix map") },
  { kind: "transport", code: "backend_unreachable", error: () => new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }) },
  { kind: "config parse", code: "config_parse_error", error: () => Object.assign(new Error("bad config"), { name: "ConfigParseError", path: "config.yaml", detail: "bad YAML" }) },
  { kind: "config lock", code: "config_lock_timeout", error: () => Object.assign(new Error("locked"), { name: "ConfigLockError", detail: "busy" }) },
  { kind: "local auth", code: "local_token_required", error: () => Object.assign(new Error("unauthorized"), { name: "LocalTokenRequiredError" }) },
  { kind: "backend", code: "backend_refused", error: () => new Error('403: {"error":"backend_refused","message":"Refused","next":"Check permissions"}') },
  { kind: "generic", code: "cli_error", error: () => new Error("Unexpected failure") },
  { kind: "null", code: "cli_error", error: () => null },
];

describe.each(["flag", "env", "config"])("error format from %s", (source) => {
  describe.each(["text", "json", "llm"])("%s", (format) => {
    it.each(failures)("$kind keeps its exit and output contract", ({ code, error, exit = 1, legacy = false }) => {
      vi.stubEnv("IX_FORMAT", source === "env" ? format : "");
      vi.stubEnv("IX_LEGACY_EXIT_CODES", legacy ? "1" : "");
      vi.mocked(readConfiguredFormat).mockReturnValue(source === "config" ? format : undefined);
      const argv = source === "flag" ? ["patches", "--format", format] : ["patches"];
      setErrorFormat(detectRequestedFormat(argv));
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const quit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      expect(() => renderCliError(error())).toThrow("exit");
      expect(quit).toHaveBeenCalledWith(exit);
      if (format === "text") {
        expect(out).not.toHaveBeenCalled();
        expect(err.mock.calls.length + stderr.mock.calls.length).toBeGreaterThan(0);
      } else {
        expect(out).toHaveBeenCalledTimes(1);
        const line = String(out.mock.calls[0][0]);
        if (format === "json") {
          expect(JSON.parse(line)).toMatchObject({ error: code, message: expect.any(String) });
        } else {
          expect(line).toMatch(new RegExp(`^error code=${code} message=`));
          expect(line.split("\n")).toHaveLength(1);
        }
        expect(err).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
      }
    });
  });
});

describe("error format precedence and recovery", () => {
  it("lets a flag override the environment and config without reading config", () => {
    vi.stubEnv("IX_FORMAT", "json");
    vi.mocked(readConfiguredFormat).mockImplementation(() => { throw new Error("unreadable"); });
    expect(detectRequestedFormat(["patches", "--format", "text"])).toBe("text");
    expect(readConfiguredFormat).not.toHaveBeenCalled();
  });

  it("lets the environment override config without reading config", () => {
    vi.stubEnv("IX_FORMAT", "json");
    vi.mocked(readConfiguredFormat).mockImplementation(() => { throw new Error("unreadable"); });
    expect(detectRequestedFormat(["patches"])).toBe("json");
    expect(readConfiguredFormat).not.toHaveBeenCalled();
  });

  it("uses the last flag, like Commander", () => {
    expect(detectRequestedFormat(["patches", "--format", "llm", "--format=json"])).toBe("json");
  });

  it("honours the environment after -- and normalizes it like the default resolver", () => {
    vi.stubEnv("IX_FORMAT", " JSON ");
    expect(detectRequestedFormat(["text", "--", "--format", "llm"])).toBe("json");
  });

  it("does not skip -- when a format argument is missing", () => {
    expect(detectRequestedFormat(["text", "--format", "--", "--format", "llm"])).toBe("text");
  });

  it("ignores invalid formats and guards a config read that throws", () => {
    vi.stubEnv("IX_FORMAT", "invalid");
    vi.mocked(readConfiguredFormat).mockImplementation(() => { throw new Error("unreadable"); });
    expect(detectRequestedFormat(["patches", "--format", "invalid"])).toBe("text");
  });

  it("falls back from an invalid environment value to normalized config", () => {
    vi.stubEnv("IX_FORMAT", "invalid");
    vi.mocked(readConfiguredFormat).mockReturnValue(" LLM ");
    expect(detectRequestedFormat(["patches"])).toBe("llm");
  });
});
