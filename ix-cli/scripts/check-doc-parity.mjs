#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

/**
 * Docs parity gate for the OSS CLI surface — part 2 of #576.
 *
 * The RFC asked for a committed check so a registered command or flag cannot
 * merge without a doc mention. #578 shipped the inventory half
 * (scripts/dump-cli-surface.mjs + skills/ix/references/flags.md); this is the
 * compare half, wired into CI by .github/workflows/ci.yml.
 *
 * It reads the *registered commander tree* from dist/ (never a regex over
 * source), walks the same command/flag shape dump-cli-surface.mjs prints, and
 * compares both directions against the flag reference:
 *
 *   - a registered command with no doc section          -> fail, named
 *   - a registered long flag with no doc row            -> fail, named
 *   - a doc row for a flag the CLI no longer registers  -> fail, named (stale)
 *   - a doc section for a command that is gone          -> fail, named (stale)
 *
 * Both halves of #576 matter. Gating flags alone leaves every flagless command
 * unreachable, and 14 of the 54 registered here have no long flag at all.
 *
 * Inactive while skills/ix/references/flags.md is absent: with zero coverage
 * the check would only report the whole command surface, so it exits 0 with a
 * notice and activates the moment the reference file exists. That keeps CI
 * green before #578 merges and strict from then on.
 *
 * Then the rendered workflow skills (skills/workflows/*.md, rendered per host
 * from skills/hosts.json, #995): every command, flag, MCP tool and argument,
 * and output field the text names must exist. See check-skill-parity.mjs for
 * what is read and how. This half runs whether or not flags.md exists.
 *
 *   node scripts/check-doc-parity.mjs          # default doc path, from repo root
 *   node scripts/check-doc-parity.mjs --doc P  # explicit doc path (testing)
 *   node scripts/check-doc-parity.mjs --hosts P --workflows D   # other skill templates (testing)
 *
 * Exit 0 = parity; 1 = gaps listed on stdout.
 */
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkSkills, loadSkillSurface, readSnapshots } from "./check-skill-parity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const ossPath = join(here, "..", "dist", "cli", "register", "oss.js");
const serverPath = join(here, "..", "dist", "mcp", "server.js");
const proSurfacePath = join(here, "..", "dist", "cli", "register", "pro-surface.js");
const flagsDocDefault = join(repoRoot, "skills", "ix", "references", "flags.md");

/**
 * Read `--name <value>` / `--name=<value>` from argv. A flag with no value —
 * last argument, or followed by another flag — is a usage error, not a crash:
 * `existsSync(undefined)` would throw a TypeError instead of telling the
 * caller what to fix.
 */
const argValue = (name, fallback) => {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    process.stderr.write(`error: option '${name} <value>' argument missing\n`);
    process.exit(1);
  }
  return v;
};

const flagsDoc = argValue("--doc", flagsDocDefault);
const hostsPath = argValue("--hosts", join(repoRoot, "skills", "hosts.json"));
const workflowsDir = argValue("--workflows", join(repoRoot, "skills", "workflows"));

/** Import a dist/ module, or exit 1 saying to build. */
async function loadBuilt(path) {
  try {
    return await import(pathToFileURL(path).href);
  } catch (err) {
    process.stderr.write(
      `cannot load ${path}\nRun 'npm run build' in ix-cli first.\n${err}\n`,
    );
    process.exit(1);
  }
}

let flagsOk = true;
if (existsSync(flagsDoc)) {
  flagsOk = checkFlagReference((await loadBuilt(ossPath)).registerOssCommands);
} else {
  console.log(
    `check-doc-parity: no flag reference at ${flagsDoc} — ` +
      "gate inactive until the reference ships (#576, #578)",
  );
}
const skillsOk = await checkWorkflowSkills();
process.exit(flagsOk && skillsOk ? 0 : 1);

/** Part one: registered commands and flags vs flags.md. True on parity. */
function checkFlagReference(registerOssCommands) {
  const program = new Command();
  program.name("ix");
  registerOssCommands(program);

  // Registered surface: every command name (rooted at `ix`, matching the doc's
  // `### \`ix <cmd>\`` section headers), plus the long flags per command for the
  // flag-bearing ones. A command with no flags still has a legitimate doc
  // section, so section staleness is checked against all names.
  const allCommands = new Set();
  const registered = new Map();
  function walk(cmd, parentPath) {
    const name = parentPath ? `${parentPath} ${cmd.name()}` : `ix ${cmd.name()}`;
    allCommands.add(name);
    const longs = new Set();
    for (const o of cmd.options ?? []) {
      if (!o.long) continue;
      // Commander auto-registers `-h, --help` on every command; the flag
      // reference deliberately carries no help rows.
      if (o.long === "--help") continue;
      longs.add(o.long);
    }
    if (longs.size > 0) registered.set(name, longs);
    for (const sub of cmd.commands ?? []) walk(sub, name);
  }
  for (const cmd of program.commands) walk(cmd, "");

  // Documented surface: per command section in flags.md, the backticked
  // `--flag` tokens in its table rows. Section headers look like
  // `### \`ix callees <symbol>\`` or `#### \`ix config show\`` — strip any
  // `<arg>` / `[arg]` tokens from the command name.
  const docLines = readFileSync(flagsDoc, "utf8").split(/\r?\n/);
  const documented = new Map();
  let current = null;
  for (const line of docLines) {
    const head = line.match(/^(#{2,4}) `([^`]+)`\s*$/);
    if (head) {
      if (head[2].startsWith("ix ")) {
        const parts = head[2]
          .split(/\s+/)
          .filter((t) => !/^[<[].*[>\]]$/.test(t));
        current = parts.join(" ");
        if (!documented.has(current)) documented.set(current, new Set());
        continue;
      }
      current = null;
      continue;
    }
    if (!current) continue;
    for (const m of line.matchAll(/`(--[\w-]+)`/g)) {
      documented.get(current).add(m[1]);
    }
  }

  const missingSections = []; // registered command with no doc section
  const missing = []; // registered flag with no doc row
  const stale = []; // doc row or section with no registered counterpart

  // #576 asks that a registered command *or* flag cannot merge without a doc
  // mention. Gating flags alone leaves the flagless commands unreachable: 14 of
  // the 54 registered here (`ix init`, the four `ix docker` subcommands, the
  // `ix config` family, `ix view stop|status`, `ix savings reset`, `ix mcp`,
  // `ix help`) carry no long flag at all, so nothing about them was ever
  // compared and a new one could merge with no section.
  //
  // Nothing is excluded. `--help` is skipped above because commander registers
  // it on every command; there is no command-side equivalent — `ix help
  // [topic]` is a real Ix command with real behaviour (`ix help workflows`,
  // `ix help advanced`, and the collapsed-plural forwarding of Ix-pro#103/#108),
  // registered by registerWorkflowsHelpCommand, and it deserves a section like
  // any other.
  for (const cmd of [...allCommands].sort()) {
    if (!documented.has(cmd)) missingSections.push(cmd);
  }

  for (const [cmd, flags] of registered) {
    // A command with no section at all is reported once, as the section it
    // needs. Listing each of its flags as a separate missing row would bury the
    // one edit that fixes them.
    if (!documented.has(cmd)) continue;
    const known = documented.get(cmd);
    for (const f of [...flags].sort()) {
      if (!known.has(f)) missing.push(`${f} (on ${cmd})`);
    }
  }
  for (const [cmd, flags] of documented) {
    if (!allCommands.has(cmd)) {
      stale.push(`section for ${cmd} has no registered command`);
      continue;
    }
    const reg = registered.get(cmd);
    if (!reg) continue; // command exists but registers no long flags
    for (const f of [...flags].sort()) {
      if (!reg.has(f)) stale.push(`${f} (under ${cmd})`);
    }
  }

  const totalFlags = [...registered.values()].reduce((n, s) => n + s.size, 0);
  if (missingSections.length === 0 && missing.length === 0 && stale.length === 0) {
    console.log(
      `check-doc-parity: ${allCommands.size} commands, ${totalFlags} flags — ` +
        `parity with ${flagsDoc}`,
    );
    return true;
  }

  for (const c of missingSections) console.log(`missing doc section: ${c}`);
  for (const f of missing) console.log(`missing doc row: ${f}`);
  for (const f of stale) console.log(`stale doc row: ${f}`);
  console.log(
    `check-doc-parity: ${missingSections.length} undocumented command(s), ` +
      `${missing.length} missing flag row(s), ${stale.length} stale — fix ${flagsDoc}`,
  );
  return false;
}

/** Part two: the rendered workflow skills (#995). True when they name nothing missing. */
async function checkWorkflowSkills() {
  const surface = await loadSkillSurface({
    oss: await loadBuilt(ossPath),
    server: await loadBuilt(serverPath),
    pro: await loadBuilt(proSurfacePath),
    Command,
    snapshots: readSnapshots(join(here, "..", "src", "cli", "__tests__", "__snapshots__")),
  });
  let result;
  try {
    result = checkSkills({ hostsPath, workflowsDir, surface });
  } catch (err) {
    // hosts.json unreadable or invalid: a gap to fix, not a crash.
    console.log(`check-doc-parity: cannot check the workflow skills: ${err.message}`);
    return false;
  }
  const { problems, counts } = result;
  const checked =
    `${counts.skills} rendered skill(s): ${counts.invocations} command line(s), ` +
    `${counts.tools} MCP tool reference(s), ${counts.fields} output field reference(s)`;
  if (problems.length === 0) {
    console.log(`check-doc-parity: ${checked} — parity with ${workflowsDir}`);
    return true;
  }
  for (const p of problems) console.log(`skill: ${p}`);
  console.log(
    `check-doc-parity: ${problems.length} problem(s) in ${checked} — fix the template in ${workflowsDir}, ` +
      "or the CLI if it lost what the skill relies on",
  );
  return false;
}
