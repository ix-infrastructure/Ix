// Copyright 2026 Ix Infrastructure Inc.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Hints and next steps, as data, and the reader that phrases them.
 *
 * A command's closing advice used to be CLI text everywhere: `ix callers X`,
 * `raise --max-tokens`, `Use --include-tests`. Over MCP the same output reaches
 * an agent that has tools, not a shell, and advice the reader cannot run is
 * worse than none, because it reads as the one move left.
 *
 * So a command describes the step it means ({@link Hint}, {@link Lever}) and
 * asks the {@link Caller} it is running for how to phrase it. This module only
 * knows the CLI phrasing ({@link CLI_CALLER}), which is the exact text the
 * commands printed before. The MCP layer (`mcp/hints.ts`) supplies the other
 * reader: it alone knows the tool names and their arguments, and it phrases
 * only tools the session was offered, so a hint for anything else is dropped.
 *
 * The caller is scoped to one command run ({@link withCaller}), not read from
 * the process environment, so concurrent runs and anything else in the process
 * cannot see each other's reader.
 */

/** The four edge directions a neighbour lookup takes. */
export type Relation = "callers" | "callees" | "imports" | "imported_by";

/** One next step a command suggests, as data. */
export type Hint =
  /** One hop of edges from `symbol`. */
  | { action: "neighbors"; symbol: string; relation: Relation; path?: string }
  /** What a change to `target` reaches. */
  | { action: "impact"; target: string; path?: string }
  /** Ranked evidence for `target`; with no target, the command itself. */
  | { action: "context"; target?: string; path?: string }
  /** The source of a symbol, a path, or `path:start-end`. */
  | { action: "read"; target: string; path?: string }
  /** A text search; with no pattern, the command itself. `quote` double-quotes the CLI argument. */
  | { action: "text"; pattern?: string; quote?: boolean }
  /** What `symbol` is for. `quote` double-quotes the CLI argument. */
  | { action: "explain"; symbol: string; quote?: boolean }
  /** The dependent tree of `symbol`. */
  | { action: "depends"; symbol: string; depth?: number }
  /** The members of `symbol`. */
  | { action: "contains"; symbol: string }
  /** The claims that conflict over `symbol`. */
  | { action: "conflicts"; symbol: string }
  /** Re-map the workspace. */
  | { action: "map" }
  /**
   * The next page of the command that printed this one. `argv` is that
   * command line as shell words, already quoted, ending in `--offset <offset>`
   * and its positionals.
   */
  | { action: "page"; offset: number; argv: readonly string[] };

/** A request input a hint can point at: a flag at a shell, a tool argument over MCP. */
export type Lever = "pick" | "kind" | "path" | "all" | "include_tests" | "max_tokens";

/** Who reads a command's output, and how a hint must be phrased for them. */
export interface Caller {
  /**
   * How the reader acts on a hint: by typing a command line (`shell`), or by
   * making a tool call (`tool`). Commands choose which steps to offer by it;
   * the wording of each step comes from {@link command} and {@link lever}.
   */
  readonly style: "shell" | "tool";
  /**
   * True when the command runs inside a long-lived host process that owns its
   * deadline (`ix mcp`): it must not start services on the user's machine or
   * take a wait budget from the host's environment.
   */
  readonly hosted: boolean;
  /** The command line or tool call that performs `hint`; undefined when this reader cannot run it. */
  command(hint: Hint): string | undefined;
  /** How to set `lever` on the next request (`--pick <n>`, `pick=<n>`); undefined when there is no such input. */
  lever(lever: Lever): string | undefined;
  /** How to disambiguate a name that resolved to several entities. `cli` is the shell phrasing. */
  disambiguation(cli: string): string;
}

const RELATION_COMMAND: Record<Relation, string> = {
  callers: "callers",
  callees: "callees",
  imports: "imports",
  imported_by: "imported-by",
};

const CLI_LEVERS: Record<Lever, string> = {
  pick: "--pick <n>",
  kind: "--kind",
  path: "--path",
  all: "--all",
  include_tests: "--include-tests",
  max_tokens: "--max-tokens",
};

/** A shell runs every `ix` command, so every hint has a CLI form. */
interface CliCaller extends Caller {
  command(hint: Hint): string;
}

/**
 * A person at a shell, the default. Every form here is the string the
 * commands printed before hints were data; keep them byte-identical so CLI
 * output does not move. Paths pin a target over MCP only: the CLI forms never
 * carried one.
 */
export const CLI_CALLER: CliCaller = {
  style: "shell",
  hosted: false,
  command(hint: Hint): string {
    switch (hint.action) {
      case "neighbors":
        return `ix ${RELATION_COMMAND[hint.relation]} ${hint.symbol}`;
      case "impact":
        return `ix impact ${hint.target}`;
      case "context":
        return hint.target === undefined ? "ix context" : `ix context ${hint.target}`;
      case "read":
        return `ix read ${hint.target}`;
      case "text":
        return hint.pattern === undefined ? "ix text" : `ix text ${hint.quote ? `"${hint.pattern}"` : hint.pattern}`;
      case "explain":
        return `ix explain ${hint.quote ? `"${hint.symbol}"` : hint.symbol}`;
      case "depends":
        return `ix depends ${hint.symbol}${hint.depth === undefined ? "" : ` --depth ${hint.depth}`}`;
      case "contains":
        return `ix contains ${hint.symbol}`;
      case "conflicts":
        return `ix conflicts ${hint.symbol}`;
      case "map":
        return "ix map";
      case "page":
        return hint.argv.join(" ");
    }
  },
  lever: (lever) => CLI_LEVERS[lever],
  disambiguation: (cli) => cli,
};

const scope = new AsyncLocalStorage<Caller>();
let processCaller: Caller = CLI_CALLER;

/** The reader of the command running now: the run's caller, else the process's, else the CLI. */
export function currentCaller(): Caller {
  return scope.getStore() ?? processCaller;
}

/** Run `fn` with `caller` as the reader of everything it prints, including its async work. */
export function withCaller<T>(caller: Caller, fn: () => T): T {
  return scope.run(caller, fn);
}

/**
 * Set the reader for a whole process. Only for a process that runs one
 * command for a host (the MCP child-process runner), before the CLI loads; a
 * run's own caller ({@link withCaller}) still wins.
 */
export function setProcessCaller(caller: Caller): void {
  processCaller = caller;
}

/** `hint` phrased for the current reader, or undefined when it cannot run it. */
export function hint(step: Hint): string | undefined {
  return currentCaller().command(step);
}

/** `{ suggestedCommand }` for a row a reader can act on, or nothing when it cannot run the step. */
export function suggestedCommand(step: Hint): { suggestedCommand?: string } {
  const command = hint(step);
  return command === undefined ? {} : { suggestedCommand: command };
}

/**
 * `Use --pick <n> or --kind to <purpose>.` at a shell, `Pass pick=<n> or
 * kind=<kind> to <purpose>.` over MCP. Levers the reader has no input for are
 * left out.
 */
export function leverSentence(levers: readonly Lever[], purpose: string): string {
  const caller = currentCaller();
  const spelled = levers.map((lever) => caller.lever(lever)).filter((text): text is string => text !== undefined);
  return `${caller.style === "tool" ? "Pass" : "Use"} ${spelled.join(" or ")} ${purpose}.`;
}

/** How a caller disambiguates a name that resolved to more than one entity. */
export function disambiguationHint(cli: string): string {
  return currentCaller().disambiguation(cli);
}
