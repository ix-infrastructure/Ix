// Copyright 2026 Ix Infrastructure Inc.

// `ix capabilities`: what this installed CLI supports, answered without the
// backend, the config file or the command tree. Plugins ask it before they
// call anything else: is `ix` new enough, is Ix Pro installed, which
// `ix hook` entry points exist. Until it existed each plugin worked that out
// its own way -- running `ix briefing` and matching "requires Ix Pro",
// parsing `ix --version`, grepping `ix mcp --help` -- and cached the answer for
// a different length of time.
//
// Kept to node built-ins and small leaf modules: `main.ts` answers
// `ix capabilities --format <fmt>` from here before `run-cli.ts` loads.

import { readCliVersion } from "./cli-version.js";
import { printJson, setPrettyJson } from "./format.js";
import { llmLine } from "./llm.js";
import { proInstallState, type ProInstallState } from "./register/pro-loader.js";

/**
 * Versioned id of the `ix capabilities --format json` shape. Bump only on a
 * breaking change (a field removed, renamed or retyped); a new field is not
 * one, and readers should ignore fields they do not know.
 */
export const CAPABILITIES_SCHEMA = "ix-capabilities/1";

/**
 * The `ix hook` subcommands this CLI registers (`commands/hook.ts`). A test
 * holds the two to the same set.
 */
export const HOOK_SUBCOMMANDS = ["claude-post-edit"] as const;

export interface Capabilities {
  /** {@link CAPABILITIES_SCHEMA}. */
  schema: string;
  /** This CLI's version, as `ix --version` prints it. */
  version: string;
  pro: {
    /** True when Pro commands should be tried: `state` is `installed`. */
    available: boolean;
    /** See {@link ProInstallState}. Pro is resolved, never loaded, here. */
    state: ProInstallState;
  };
  /** `ix hook <name>` entry points, in registration order. */
  hooks: string[];
}

export function collectCapabilities(
  probePro: () => ProInstallState = proInstallState,
  version: string = readCliVersion(),
): Capabilities {
  const state = probePro();
  return {
    schema: CAPABILITIES_SCHEMA,
    version,
    pro: { available: state === "installed", state },
    hooks: [...HOOK_SUBCOMMANDS],
  };
}

const PRO_TEXT: Record<ProInstallState, string> = {
  absent: "not installed",
  installed: "installed",
  broken: "installed but cannot be loaded (run `ix upgrade` to reinstall)",
};

/** Render for `--format text|json|llm`. */
export function renderCapabilities(caps: Capabilities, format: string): void {
  if (format === "json") {
    printJson(caps);
    return;
  }
  if (format === "llm") {
    console.log(llmLine("capabilities", [
      ["schema", caps.schema],
      ["version", caps.version],
      ["pro", caps.pro.state],
    ]));
    for (const hook of caps.hooks) console.log(llmLine("hook", [["name", hook]]));
    return;
  }
  console.log(`Version: ${caps.version}`);
  console.log(`Ix Pro:  ${PRO_TEXT[caps.pro.state]}`);
  console.log(`Hooks:   ${caps.hooks.length > 0 ? caps.hooks.join(", ") : "none"}`);
}

const FORMATS = new Set(["text", "json", "llm"]);

/**
 * The arguments after `capabilities` that `main.ts` may answer without the
 * CLI: an explicit `--format` (`--format json` or `--format=json`) and
 * optionally `--pretty`, nothing else. Undefined for anything more, which then
 * goes to the full CLI: no `--format` (the default comes from IX_FORMAT and
 * config, which this path does not read), `--help`, or a flag commander should
 * reject in its own words.
 */
export function parseFastCapabilitiesArgs(rest: readonly string[]): { format: string; pretty: boolean } | undefined {
  let format: string | undefined;
  let pretty = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--pretty") {
      pretty = true;
    } else if (arg === "--format" && i + 1 < rest.length && FORMATS.has(rest[i + 1])) {
      format = rest[++i];
    } else if (arg.startsWith("--format=") && FORMATS.has(arg.slice("--format=".length))) {
      format = arg.slice("--format=".length);
    } else {
      return undefined;
    }
  }
  return format === undefined ? undefined : { format, pretty };
}

/**
 * Answer `ix capabilities <rest>` before the command tree loads. False, having
 * printed nothing, when `rest` is not one {@link parseFastCapabilitiesArgs}
 * accepts, or when IX_LOAD_ALL_COMMANDS=1 (`register/oss-table.ts`, not
 * imported here to keep this path small) asks for the full CLI.
 */
export function runFastCapabilities(rest: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.IX_LOAD_ALL_COMMANDS === "1") return false;
  const args = parseFastCapabilitiesArgs(rest);
  if (args === undefined) return false;
  setPrettyJson(args.pretty);
  renderCapabilities(collectCapabilities(), args.format);
  return true;
}
