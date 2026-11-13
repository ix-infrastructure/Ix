// Copyright 2026 Ix Infrastructure Inc.

import { claudeCodeAdapter } from "./hosts/claude.js";
import { cursorAdapter } from "./hosts/cursor.js";
import { geminiCliAdapter } from "./hosts/gemini.js";

/**
 * The hook layer's seam between Ix and an agent host. Each host runs a hook
 * as a command, hands it the event as JSON on stdin and reads JSON back from
 * stdout -- but every host names the fields differently. An adapter turns the
 * host's payload into a {@link HookEvent} and Ix's answer into the host's
 * JSON, so the code behind `ix hook` reads one shape whichever host ran it.
 *
 * Loaded before the CLI, on every hooked tool call: adapters import nothing
 * beyond node's builtins.
 */

/** What a hook needs to know about the host event, in no host's spelling. */
export interface HookEvent {
  /** The adapter that read it ({@link HostAdapter.id}). */
  host: string;
  /** The host's own name for the event (Claude Code: `PostToolUse`, `UserPromptSubmit`, ...). */
  event?: string;
  /** The directory the agent runs in, as the host gave it; not checked to be absolute. */
  cwd?: string;
  sessionId?: string;
  toolName?: string;
  /** Files the tool call says it edited, as the host gave them (possibly relative to `cwd`). Empty for a call that edits nothing. */
  editedPaths: string[];
  /** The user's prompt, on a prompt-submit event. */
  prompt?: string;
  /** The host's parsed payload, for a hook that needs a field only that host has. */
  payload: unknown;
}

/** What a hook answers a host that asks whether to go ahead with an action. */
export type HookDecision = "allow" | "deny" | "ask";

export interface HostAdapter {
  /** The name `--host` takes. */
  id: string;
  /** The event in `raw` stdin, or undefined when it is not a payload this host sends. Never throws. */
  readEvent(raw: string): HookEvent | undefined;
  /**
   * The stdout that hands `additionalContext` to the model on the host event
   * `event`; "" (print nothing) on an event where the host reads no context.
   */
  writeContext(event: string, additionalContext: string): string;
  /**
   * The stdout that allows, denies or asks the user about the action the host
   * is about to take on `event` (a before-tool event). `reason` is the why,
   * for the agent and, where the host shows one, the user. "" on an event
   * where the host reads no decision; a host that cannot ask on `event` gets
   * a deny for "ask".
   */
  writeDecision(event: string, decision: HookDecision, reason?: string): string;
  /** The project directories `event` names, as the host gave them: not checked to be absolute. */
  projectDirs(event: HookEvent): string[];
  /** The variable the host sets to the project directory for its hook commands, when it sets one. */
  projectDirEnv?: string;
}

export const HOST_ADAPTERS: readonly HostAdapter[] = [claudeCodeAdapter, cursorAdapter, geminiCliAdapter];

export function hostAdapter(id: string): HostAdapter | undefined {
  return HOST_ADAPTERS.find((a) => a.id === id);
}
