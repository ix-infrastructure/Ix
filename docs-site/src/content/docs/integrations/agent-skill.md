---
title: Agent skill
description: Teach any LLM agent to drive the ix CLI with the bundled skill.
---

The [`skills/ix/`](https://github.com/ix-infrastructure/Ix/tree/main/skills/ix) directory is an agent skill. It teaches
an agent which `ix` command answers which question, how to keep answers bounded, and how to recover from common
errors.

It follows the [Claude Code skill format](https://code.claude.com/docs/en/skills) and the
[agents.md](https://agents.md) standard, so Claude Code, Codex, Cursor and other agents load the same skill from
their own skills directory.

## Install

From a checkout of the Ix repository:

```bash
bash scripts/install-skill.sh             # deploy to every agent found on this machine
bash scripts/install-skill.sh --dry-run   # preview where it would go
```

Start a new agent session so the skill is loaded, then ask:

> Set up Ix and map this repo.

The skill's bootstrap script checks for Node.js 22+, git, Docker and ripgrep, installs the CLI if it's missing,
starts the backend and maps the repository.

## What's in it

| File | Purpose |
|---|---|
| `SKILL.md` | The entry point: when to use Ix and the core workflow |
| `references/commands.md` | Routes a goal to a command. Rendered here as the [command reference](/reference/commands/) |
| `references/flags.md` | Every flag of every command. Rendered here as the [flag reference](/reference/flags/) |
| `references/output-formats.md` | Choosing `text`, `json` or `llm` |
| `references/troubleshooting.md` | Recovering from common failures |
| `scripts/bootstrap.sh` / `.ps1` | First-run setup |

## Skill or MCP?

They work together. The MCP server gives an agent native tools. The skill teaches an agent that runs shell commands
how to use the CLI well. If your client supports MCP, register the server with `ix mcp install` too.
