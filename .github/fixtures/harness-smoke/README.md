# Harness smoke fixture

This fixture is intentionally small and offline. It is consumed by the
`harness-install-smoke` CI job through `TOOLSCAN_PATH`.

- `claude` — a fake `claude` binary the job copies to `$HOME/.local/bin/claude`
  (off PATH, exactly where toolscan's extra scan roots matter). Only the fake
  toolscan output names it, so the CLI must both decide presence from toolscan
  and *execute* the absolute path toolscan reported — if the seam regressed to
  PATH-only execution, `ix mcp install` would report a false `conflict`.
- `toolscan.mjs` — fake toolscan output naming `claude` at
  `/tmp/ix-harness-home/.local/bin/claude` (the job's HOME).
- The fixture HOME starts empty, so no config-directory probe can make an
  absent host look present. `codex`, `agents` and `cursor` are in the skills
  table but absent here; `openclaw`/`gemini`/`opencode`/`vscode` have no
  skills convention and must not appear as install targets at all.

`ix mcp install` is exercised with `--host claude codex openclaw` (the same
registry restriction the old `HARNESS_HOSTS_FILE` fixture provided; an unknown
host id fails loudly, so a renamed host cannot pass silently).