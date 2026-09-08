<p align="center">
  <img src="./ix-cli/assets/logo.png" width="34%" alt="Ix" />
</p>

<h1 align="center">Give your AI a map of your codebase.</h1>

<p align="center">
  Ix parses your repository into a persistent system graph — symbols, calls, imports, relationships —<br/>
  so you and your coding agents can query structure instead of grepping and guessing.
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/ix-infrastructure/Ix" alt="Stars" />
  <img src="https://img.shields.io/github/license/ix-infrastructure/Ix" alt="License" />
  <img src="https://img.shields.io/github/actions/workflow/status/ix-infrastructure/Ix/ci.yml?label=tests" alt="Tests" />
  <img src="https://img.shields.io/badge/platform-windows%20%7C%20macOS%20%7C%20linux-lightgrey" alt="Platforms" />
</p>

<p align="center">
  <a href="https://www.ix-infra.com">Website</a> ·
  <a href="./docs">Docs</a> ·
  <a href="https://compass.ix-infra.com">Live demo</a> ·
  <a href="https://discord.gg/ncEYVHVqZ8">Discord</a>
</p>

```bash
curl -fsSL https://ix-infra.com/install.sh | sh    # macOS / Linux
```

<p align="center">
  <img src="./assets/demo.gif" width="90%" alt="Ix mapping and querying a repository" />
</p>

---

## Try it

```bash
ix map .                      # build the graph for this repo
ix explain AuthService        # what is this, and what does it touch?
ix trace user_login_flow      # how does this actually flow?
ix impact verify_token        # what breaks if I change this?
```

The graph lives on your machine and persists between sessions. Your agent navigates
it through [MCP](#integrations) instead of re-deriving your architecture
from whatever fits in a prompt.

---

## Why Ix

| | Without Ix | With Ix |
|---|---|---|
| **Finding things** | Search, read, search again | Query a structured graph |
| **Architecture** | Re-derived every session | Mapped once, kept |
| **Agent context** | Whole files pasted into the prompt | Bounded structural slices |
| **Between sessions** | Context is lost | The graph persists |
| **Relationships** | Inferred from fragments | Read from real edges |

## The model

**Map → Structure → Retrieve → Remember**

| Step | What happens |
|---|---|
| **Map** | `ix map .` parses the repo with tree-sitter and extracts symbols, calls and imports. |
| **Structure** | Those become nodes and edges — a graph of what calls, contains and imports what. |
| **Retrieve** | Commands return bounded answers about one symbol or flow, not whole files. |
| **Remember** | The graph is stored locally and survives between sessions and agent runs. |

## How it works

<p align="center">
  <img src="./assets/arch.png" width="100%" alt="Ix architecture" />
</p>

`ix map` parses your repository with tree-sitter, extracts symbols, calls and
imports, and persists them as a graph in a local backend — ArangoDB plus the memory
layer, run for you in Docker. Three clients read that graph: the `ix` CLI, the
`ix mcp` server your AI clients connect to, and Compass, the visualizer `ix view`
opens.

The backend ships as a released Docker image; it is not built from this repo. See
the [HTTP API reference](./docs/api/) for the endpoints all three clients share.

## Results

Across our own development work, querying the graph instead of feeding files into
the prompt cut token use by **30–99.7%**, varying widely with the task and the size
of the repo. These are internal measurements, not a published benchmark.

The mechanism is the plain part: `ix explain AuthService` returns that symbol and
its immediate relationships. Answering the same question by reading the file — and
the files it imports — costs far more, and costs it again next session.

## Integrations

Ix ships a stdio MCP server, so any MCP-capable client can use the same graph tools.

```bash
ix mcp install            # detect installed clients and register `ix mcp` with each
ix mcp install --dry-run  # show what would change, write nothing
ix mcp doctor             # check each client's registration
```

`install` knows **Claude Code, Codex, Cursor, VS Code, Gemini CLI, OpenClaw and
opencode**. It writes through each client's own MCP command where one exists, and
never overwrites a server name it does not own — pass `--force` to replace one, or
`--host <id>` to limit the run. Per-client write mechanics, repair and process
isolation are in [docs/mcp.md](./docs/mcp.md).

To register one client by hand:

```bash
codex mcp add ix-memory -- ix mcp
```

### Agent skill

[`skills/ix/`](skills/ix/SKILL.md) teaches any LLM agent to drive the CLI. It follows the
[Claude Code skill format](https://code.claude.com/docs/en/skills) and the
[agents.md](https://agents.md) standard, so Claude Code, Agents, Codex and Cursor all
load the same tree from their own skills directory.

```bash
bash scripts/install-skill.sh   # deploy to every harness found (--dry-run to preview)
```

Then ask your agent: *"Set up Ix and map this repo."*

### Native plugins

Optional per-client packages, if you prefer them to `ix mcp install`:

```bash
# Claude Code
/plugin marketplace add ix-infrastructure/ix-claude-plugin
/plugin install ix-memory

# Codex
curl -fsSL https://ix-infra.com/codex-install.sh | sh

# OpenClaw
openclaw plugins install ix-infrastructure/ix-openclaw-plugin

# Gemini
gemini extensions install https://github.com/ix-infrastructure/ix-gemini-plugin

# OpenCode
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/ix-opencode-plugin/main/install.sh | bash

# Cursor
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/ix-cursor-plugin/main/install.sh | bash
```

Each also publishes a Windows PowerShell installer — swap `install.sh | bash` for
`install.ps1 | iex` via `irm`.

## Install

**macOS / Linux**

```bash
curl -fsSL https://ix-infra.com/install.sh | sh
```

**Windows** — install Node.js 22+ and Docker Desktop first, then:

```powershell
irm https://ix-infra.com/install.ps1 | iex
```

Then map a repo and register your AI clients:

```bash
ix map .
ix mcp install
```

The installer checks for and installs anything missing: **Node.js 22+, Git, ripgrep**
(powers `ix text`), and **Docker + Docker Compose** for the local backend. All you need
beforehand is a terminal with `curl` or `wget`.

<details>
<summary><b>Platform notes and edge cases</b></summary>

<br/>

Pre-built CLI packages are published for Apple Silicon macOS, Linux (x86-64 and
arm64) and Windows x86-64.

**Intel Macs** have no pre-built package. Install with Homebrew, which builds from
source:

```bash
brew tap ix-infrastructure/ix https://github.com/ix-infrastructure/Ix
brew install ix
```

For the full list — including the endpoints the installer reaches and the
directories it creates — see [docs/prerequisites.md](./docs/prerequisites.md).

</details>

## Commands

Ix talks to a local backend, so start there if a command reports
`Ix backend not reachable`:

```bash
ix status          # is the backend reachable?
ix docker start    # start it (ArangoDB + memory layer)
ix doctor          # server, database and graph integrity
```

Set `IX_DEBUG=1` for full stack traces on any error.

**Build the graph**

```bash
ix map .           # map this repo
ix watch           # re-map on change
```

**Understand**

```bash
ix search <term>       # find an entity by name
ix locate <symbol>     # jump to a definition
ix explain <symbol>    # what it is and what it touches
ix overview <target>   # one-shot structural summary
ix impact <target>     # blast radius of a change
ix read <target>       # read source, by symbol or path:line-range
```

**Explore**

```bash
ix trace <symbol>      # follow a flow up and down
ix callers <symbol>    # what calls this
ix callees <symbol>    # what this calls
ix rank --by dependents --top 10   # find the load-bearing code
ix inventory --kind function       # list components
ix history <target>    # how an entity changed
ix diff <from> <to>    # compare two revisions
```

**Inspect the system**

```bash
ix view            # open the Compass visualizer
ix stats           # graph statistics
ix smells          # detect structural issues
```

Query commands take `--format text|json|llm`. Use `llm` when an agent reads the
output — it is token-minimal and newline-delimited
([spec](./docs/llm-format.md)). Use `json` when chaining commands.

Exhaustive references: **[commands](skills/ix/references/commands.md)** ·
**[flags](skills/ix/references/flags.md)** ·
**[output formats](skills/ix/references/output-formats.md)** ·
**[troubleshooting](skills/ix/references/troubleshooting.md)**

## Supported languages

Symbols, calls and imports are extracted across **27 languages**:

`JavaScript` `TypeScript` `Python` `Java` `C` `C++` `C#` `Go` `Ruby` `Rust` `PHP`
`Kotlin` `Swift` `Scala` `R` `SAS` `Elixir` `Haskell` `Zig` `Lua` `Bash`
`PowerShell` `HTML` `XML` `CSS` `HCL / Terraform` `Makefile`

CUDA (`.cu` / `.cuh`) is parsed with the C++ grammar, including kernel-launch
syntax (`kernel<<<grid, block>>>(args)`), so host-to-kernel calls appear in the
graph. Python stub files (`.pyi`) are parsed as Python.

Also recognized as config and data formats: `YAML` `JSON` `TOML` `SQL`
`Protocol Buffers` `Dockerfile` `Markdown` `LaTeX`

## Built on Ix: Kartr

Ix maps your code. **[Kartr](https://www.ix-infra.com)** is an agent platform built on
the same memory engine, extended to the sources a codebase does not contain — docs and
files, email and calendar, meetings and notes, team chat — so agents carry context
across all of them.

Kartr is in alpha and onboarding early users.

<p align="center">
  <a href="https://docs.google.com/forms/d/e/1FAIpQLSdh5IXVGW9mNBUtyBAsP_uysS38GgilpTNMbKRAVQf1FZ1eBg/viewform?usp=pp_url&amp;entry.2087374943=ix_github" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Sign%20up%20for%20the%20Kartr%20alpha-%E2%86%92-8A2BE2?style=for-the-badge" alt="Sign up for the Kartr alpha" />
  </a>
</p>

## Status

Alpha, and moving quickly. APIs and behavior may change. If you are running Ix on a
large or unusual codebase, we want the bug report.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for local
setup, and [SECURITY.md](SECURITY.md) to report a vulnerability.

<p align="center">
  <a href="./docs">Docs</a> ·
  <a href="https://www.ix-infra.com">Website</a> ·
  <a href="https://compass.ix-infra.com">Live demo</a> ·
  <a href="https://discord.gg/ncEYVHVqZ8">Discord</a>
</p>

<p align="center">
  Licensed under <a href="LICENSE">Apache 2.0</a>. ⭐ Star the repo if Ix is useful to you.
</p>
