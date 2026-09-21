# Project: Ix (this repo)

This checkout is **Ix itself** plus the **`ix` agent skill** that wraps it. The
backend is NOT in this repo — it is the released Docker image running at
`http://localhost:8090`; the Compass visualizer serves the SPA + API proxy on
`http://localhost:8080`. Requires Node ≥ 22, git, Docker, ripgrep.

## Layout

| Path | What it is |
|---|---|
| `ix-cli/` | The `@ix/cli` TypeScript package — command routing (`src/cli/`), registration hub (`src/cli/register/oss.ts`), HTTP client (`src/client/api.ts`), response types (`src/client/types.ts`) |
| `core-ingestion/` | Tree-sitter parser/classifier (26 languages) |
| `skills/ix/` | The agent skill this project ships: `SKILL.md`, `references/` (commands, flags, output-formats, troubleshooting), `scripts/` (bootstrap.sh/ps1) |
| `docs/` | `api/` (HTTP API reference + OpenAPI spec), `llm-format.md`, `prerequisites.md` |
| `scripts/` | `bootstrap.sh` (first-run), `install-skill.sh` (deploy skill to `~/.claude/skills` + `~/.agents/skills`) |

## Commands

```bash
# CLI dev (from ix-cli/)
npm run build         # build-core-ingestion + tsc
npm run typecheck     # tsc --noEmit
npm test              # build + vitest + parser smoke
npm run dev           # tsx src/cli/main.ts

# Skill + tooling (from repo root)
bash scripts/bootstrap.sh [repo-root]   # install CLI, start backend, map repo
bash scripts/install-skill.sh           # deploy skills/ix to ~/.claude + ~/.agents
# Repackage the skill zip into ./dist (gitignored). Needs the skill-creator
# skill installed; on Windows set PYTHONIOENCODING=utf-8 or its emoji print crashes.
python "$HOME/.agents/skills/skill-creator/scripts/package_skill.py" skills/ix ./dist

# Visualizer / preview
ix view start --all --no-open --port 8080   # combined multi-workspace view
ix map --silent                             # refresh the graph after code changes
```

## Boundaries & Gotchas (all verified this session — write these down, they cost hours)

- **`ix reset` is GLOBAL.** `ix reset` / `ix reset --code` take no workspace_id
  and wipe **every** workspace's graph in the shared backend (Ix + packwise +
  any other). The only scoped variant is `/v1/reset/workspace`, which the CLI
  does not expose. After a reset, re-map each workspace.
- **The OSS↔Pro command boundary is derived at runtime, not declared.**
  `main.ts` snapshots `ossCmdNames` right after `registerOssCommands()`; the
  Pro probe diffs against it. Adding a command to `oss.ts` silently makes it
  OSS; removing one makes Pro own it. `registerProCommands` is async and MUST
  be awaited.
- **`ix patches` is OSS, not Pro** (#371). It is implemented here and registered
  in `oss.ts`. `@ix/pro` also registers a `patches`; commander throws on the
  duplicate and Pro's `tryRegister` swallows the throw, so the OSS one — which
  registers first — wins on a Kartr install too. Do not re-add it to
  `PRO_COMMANDS`: a stub for a command that exists in OSS shadows the real
  implementation, and the failure is silent rather than a crash.
- **`ix upgrade` wipes `~/.ix/cli/compass`.** The Compass assets ship only via
  `ix upgrade`, and re-running the installer re-extracts over them, so a
  re-install can leave `ix view` with no UI. `bootstrap.sh` re-runs `ix upgrade`
  when it finds the directory missing; skip that with `IX_SKIP_COMPASS=1`.
- **Windows path trap:** Git Bash `/tmp` ≠ Windows `C:\tmp` — node/python
  cannot read files Git Bash wrote to `/tmp`. Use project-relative paths.

## Patterns

- **Skill edit workflow:** edit `skills/ix/` → `bash scripts/install-skill.sh`
  to deploy to `~/.claude/skills/ix` and `~/.agents/skills/ix` → start a new
  agent session so the skill is re-read.
- **After modifying code:** the editor plugins re-ingest the edited file on a
  debounce, so `ix map --silent` is for when you are working without one, or
  want the whole graph refreshed now — not for every edit.

## Typecheck & Test Discipline

Run `npm run typecheck` (from `ix-cli/`) after non-trivial CLI edits and
`node --check` on any edited standalone script before deploying.

---

## Using `ix` in this repo

Command routing, what each command answers, and the output formats are not
repeated here — they live where they are read on demand: `skills/ix/SKILL.md`
and `skills/ix/references/`, `docs/llm-format.md`, and `ix <command> --help`.

A ~10 KB copy of that reference used to sit in this file behind
`<!-- IX-MEMORY START -->` markers, labelled auto-generated. Nothing in this
repo has generated it for a long time.
