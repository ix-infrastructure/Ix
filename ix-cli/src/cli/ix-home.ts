// Copyright 2026 Ix Infrastructure Inc.

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The directory Ix keeps its state in: `$IX_HOME` when set, else `~/.ix`.
 *
 * Single source of truth. Before this existed, `~/.ix` was spelled out in nine
 * places across three idioms -- some honouring IX_HOME, some not -- and the
 * ones that did not were `config.ts` (config.yaml, the workspace registry,
 * ingest mtimes, map baselines, stitch scopes) and `bootstrap.ts`. That is
 * nearly all of the state a run reads and writes, so a harness that set
 * IX_HOME to isolate itself still drove the developer's real config: it took
 * its endpoint from `~/.ix/config.yaml` and registered its throwaway
 * worktrees there as workspaces. A stale endpoint in that file then failed
 * every Ix-mode run of an outside benchmark while its baseline arm passed,
 * which reads like an Ix regression rather than a leaked environment.
 *
 * Resolved on every call, deliberately not cached in a module-level const.
 * A `const IX_HOME = process.env.IX_HOME || ...` binds at import time, which
 * makes isolation a module-registry problem rather than an environment one:
 * a test that sets IX_HOME in `beforeEach` is isolated when its file runs
 * alone and not when another file imported the module first. That is exactly
 * how #498 wrote a bogus `99.0.0` upgrade notice into a real `~/.ix`. Five
 * modules still bind it that way (`backend-status`, `backend-version`,
 * `docker`, `upgrade`, `view`); each derives further path constants from it,
 * so converting them is a wider change than this one and is left as follow-up.
 */
export function ixHome(): string {
  return process.env.IX_HOME || join(homedir(), ".ix");
}
