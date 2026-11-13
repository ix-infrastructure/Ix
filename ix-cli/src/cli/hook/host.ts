// Copyright 2026 Ix Infrastructure Inc.

import { claudeCodeAdapter } from "./hosts/claude.js";

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

export interface HostAdapter {
  /** The name `--host` takes. */
  id: string;
  /** The event in `raw` stdin, or undefined when it is not a payload this host sends. Never throws. */
  readEvent(raw: string): HookEvent | undefined;
  /** The stdout that hands `additionalContext` to the model on the host event `event`. */
  writeContext(event: string, additionalContext: string): string;
}

export const HOST_ADAPTERS: readonly HostAdapter[] = [claudeCodeAdapter];

export function hostAdapter(id: string): HostAdapter | undefined {
  return HOST_ADAPTERS.find((a) => a.id === id);
}
