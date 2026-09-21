# Installing the skill into a harness

Where `scripts/install-skill.sh` puts `skills/ix`, how it decides a harness is
present, and the two environment seams its probe battery reads.

This lived in `skills/ix/SKILL.md` until it was moved here. It is contributor
documentation: an agent that loads the skill to answer a question about a
codebase pays for every byte of it and can act on none of it.

The skill installer (`scripts/install-skill.sh`) reads an explicit, small harness table from `ix-cli/scripts/skill-harnesses.mjs` — claude, agents, codex and cursor only. Each entry's skills directory is verified against what that harness actually reads (Cursor uses `~/.cursor/skills-cursor`, not `~/.cursor/skills`); gemini, opencode, openclaw and vscode have no skills convention, so they are deliberately not install targets. Adding a harness is a one-line edit in that table, after checking where the harness really looks. `ix mcp install` uses the separate MCP host registry (`ix-cli/src/mcp/hosts.ts`) — a different table answering a different question.

When `TOOLSCAN_PATH` is set, both surfaces consult its discovery output so a harness CLI installed outside `PATH` can still be found — and `ix mcp install` executes the absolute path toolscan reports, so the off-PATH harness is inspected and registered through the binary toolscan found. Toolscan is optional and additive: if it is unset or fails, the embedded `PATH` and config-directory probes remain authoritative. `TOOLSCAN_PATH` is opt-in: neither surface ever looks `toolscan` up on `PATH` (the CLI executes whatever `TOOLSCAN_PATH` names, so only set it to a binary you trust).

The probe battery has two environment seams:

| Seam | Used by | Default |
|---|---|---|
| `TOOLSCAN_PATH` | `skill-harnesses.mjs --probe`, `ix mcp install` | Unset — no toolscan, embedded probes decide |
| `HARNESS_HOME` | `skill-harnesses.mjs --probe` | `os.homedir()`; `install-skill.sh` uses the shell's `$HOME` |

For a hermetic probe with no real user configuration:

```bash
HARNESS_HOME="$(mktemp -d)" \
  node ix-cli/scripts/skill-harnesses.mjs --probe
```

To drive the same probe with a local or npm-installed toolscan bundle:

```bash
TOOLSCAN_PATH=/path/to/toolscan/dist/toolscan.mjs \
  HARNESS_HOME="$(mktemp -d)" \
  node ix-cli/scripts/skill-harnesses.mjs --probe
```

`--probe` emits `id|label|bin|config-dir|skill-dir|present|detectedVia`, where `present` is `1` or `0` and `detectedVia` names the probe that decided (`toolscan` | `path` | `config-dir` | `none`). `scripts/install-skill.sh --dry-run --json` emits the same per-harness view as machine-readable JSON: one object per host with `action` (`would-install` | `would-refuse` | `installed` | `refused` | `skip`), `dest`, and `detectedVia` — so CI can assert *how* a harness was found, not just that it was. A `would-refuse` in the preview exits 1, matching the real run's conflict exit, so scripts can rely on the two agreeing.

The install report's `--format json|llm` output carries `detectedVia` per host (`toolscan` | `path` | `config-dir` | `none`), so a consumer can see which probe decided presence — a host toolscan found reads `toolscan` even when its CLI also happens to be on PATH, and a host found by the PATH probe reads `path` rather than being misattributed to its config directory.
