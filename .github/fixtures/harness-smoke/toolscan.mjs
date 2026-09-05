#!/usr/bin/env node

// The smoke job installs the fake claude at $HOME/.local/bin and keeps it OFF
// PATH; only this scan names it. The path must match the job's HOME so the
// CLI can exec the discovered absolute path — resolve it from the environment
// rather than hardcoding the job's temp HOME, and report the .cmd twin on
// Windows (a shebang script cannot be spawned by CreateProcess; hosts.ts runs
// .cmd shims through cmd, which is exactly the branch this leg exercises).
const home = (process.env.HOME || "/tmp/ix-harness-home").replace(/\\/g, "/");
const claude = process.platform === "win32" ? `${home}/.local/bin/claude.cmd` : `${home}/.local/bin/claude`;
process.stdout.write(JSON.stringify({
  tools: [{ name: "claude", path: claude, source: "root" }],
  truncated: false,
}));