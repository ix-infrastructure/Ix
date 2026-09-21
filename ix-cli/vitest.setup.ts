// Copyright 2026 Ix Infrastructure Inc.

// Runs before every test file (vitest `setupFiles`).
//
// Strip an ambient IX_HOME. `config.ts` resolves the state directory through
// `ixHome()` -- `$IX_HOME`, else `~/.ix` -- so a developer, or a harness such
// as a benchmark, that has IX_HOME exported would otherwise have every test
// that isolates itself by overriding HOME write to THEIR real state directory
// instead of the temp home it set up: a HOME override relocates `~/.ix`, not
// `$IX_HOME`. Eight files isolate that way today.
//
// Deleting the variable here restores the invariant those files were written
// against, and costs nothing for the files that set IX_HOME themselves: they
// do so in `beforeEach`, which runs after this. Per file, not once per worker
// -- vitest re-runs setupFiles for each file, and `process.env` is per worker
// under the default forks pool, so no file can leak an IX_HOME to the next.
delete process.env.IX_HOME;
