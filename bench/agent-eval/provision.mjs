// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute } from './process.mjs';
import { sha256 } from './manifest.mjs';
import { findBinary, shellQuote } from './isolation.mjs';
import { MCP_SERVER, PLUGIN_NAME } from './integration.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const run = (request, argv, input) => execute(argv, { cwd: request.repo_path, seconds: request.environment.seconds, input });

export function integrationFiles(request) {
  const plugin = join(request.run_path, 'plugin');
  const hook = [process.execPath, join(root, 'hook.mjs')];
  // Map refresh and claude-post-edit each have an environment.seconds deadline; Claude's default hook timeout is shorter.
  const hookTimeout = 2 * request.environment.seconds + 30;
  if (request.agent.family === 'claude') return {
    [join(plugin, '.claude-plugin', 'plugin.json')]: json({ name: PLUGIN_NAME, version: '1.0.0', description: 'Pinned local Ix benchmark integration' }),
    [join(plugin, '.mcp.json')]: json({ mcpServers: { [MCP_SERVER]: { command: 'ix', args: ['mcp'] } } }),
    [join(plugin, 'hooks', 'hooks.json')]: json({ hooks: { PostToolUse: [{ matcher: 'Edit|MultiEdit|Write|Bash', hooks: [{ type: 'command', command: hook.map(shellQuote).join(' ') + ' claude', timeout: hookTimeout }] }] } }),
  };
  if (request.agent.family === 'codex') return {
    [join(request.home, '.codex', 'config.toml')]: `notify = ${JSON.stringify([...hook, 'codex'])}\n[mcp_servers.${MCP_SERVER}]\ncommand = "ix"\nargs = ["mcp"]\n`,
    [join(plugin, 'plugin.json')]: json({ name: PLUGIN_NAME, family: 'codex', source_revision: request.environment.plugin_revision, transport: 'ix mcp', hook: 'notify:agent-turn-complete' }),
  };
  throw new Error('Local provisioning requires Claude Code or Codex');
}

async function pinnedSkills(request) {
  const { source_path: source, plugin_revision: revision } = request.environment;
  const head = (await run(request, ['git', '-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  if (head !== revision) throw new Error('Ix source revision differs from plugin pin');
  await run(request, ['git', '-C', source, 'diff', '--exit-code', revision, '--', 'ix-cli/src', 'skills/ix']);
  const names = (await run(request, ['git', '-C', source, 'ls-tree', '-r', '--name-only', revision, '--', 'skills/ix'])).stdout.trim().split('\n');
  if (!names.includes('skills/ix/SKILL.md')) throw new Error('Pinned source has no Ix skill');
  const base = request.agent.family === 'claude' ? join(request.run_path, 'plugin', 'skills', 'ix') : join(request.repo_path, '.agents', 'skills', 'ix');
  const files = {};
  for (const name of names) {
    if (!/^skills\/ix\/[\w./-]+$/.test(name) || name.split('/').includes('..')) throw new Error('Invalid pinned skill path');
    files[join(base, name.slice('skills/ix/'.length))] = (await run(request, ['git', '-C', source, 'show', `${revision}:${name}`])).stdout;
  }
  return files;
}

/** Reject upstream agent configuration instead of silently modifying task files. */
export function checkTaskIsolation(request) {
  if (!request.synthetic) {
    for (let parent = dirname(request.repo_path); ; parent = dirname(parent)) {
      for (const name of ['AGENTS.md', 'CLAUDE.md', '.claude', '.codex', '.agents', '.mcp.json']) {
        // Developer homes usually hold ~/.claude or ~/.codex, so name the culprit.
        if (existsSync(join(parent, name))) throw new Error(`Ambient ancestor agent configuration at ${join(parent, name)}; choose an output directory outside that project and outside any home directory holding agent configuration`);
      }
      if (parent === dirname(parent)) break;
    }
  }
  for (const name of ['.claude', '.codex', '.mcp.json', 'CLAUDE.md', 'AGENTS.md']) {
    if (existsSync(join(request.repo_path, name))) throw new Error(`Task contains ambient agent configuration: ${name}`);
  }
  // The only project agent config allowed is our pinned Codex skill.
  const agents = join(request.repo_path, '.agents');
  if (existsSync(agents) && !(request.arm === 'ix' && request.agent.family === 'codex' &&
    readdirSync(agents).join() === 'skills' && readdirSync(join(agents, 'skills')).join() === 'ix')) {
    throw new Error('Task contains ambient agent skills');
  }
}

export function assertMapped(status, stats) {
  if (status.graphCompleted !== true || status.mapCompleted !== true || status.staleFiles !== 0 ||
      (status.replayedFiles ?? []).length || (status.parseTimeouts ?? []).length ||
      status.graphHealth?.status !== 'ok' || !(stats.nodes?.total > 0)) {
    throw new Error('Ix is unmapped, stale, incomplete or unhealthy in this checkout');
  }
}

export async function setup(request) {
  checkTaskIsolation(request);
  if (request.arm === 'baseline') return;
  const files = { ...integrationFiles(request), ...await pinnedSkills(request) };
  for (const [path, text] of Object.entries(files)) write(path, text);
  await run(request, ['ix', 'map', '--silent']);
}

export async function probe(request) {
  checkTaskIsolation(request);
  const head = (await run(request, ['git', 'rev-parse', 'HEAD'])).stdout.trim();
  if (head !== request.task.base_commit) throw new Error('Task checkout moved from pinned base');
  const version = (await run(request, [request.agent.binary ?? request.agent.family, '--version'])).stdout.trim();
  if (!version.split(/\s+/).includes(request.agent.version)) throw new Error('Agent version differs from pin');
  let available = false;
  try { findBinary('ix'); available = true; } catch { /* baseline must have no launcher */ }
  const ix = request.arm === 'ix';
  if (available !== ix) throw new Error('Ix PATH isolation is incorrect');
  const evidence = [];
  if (ix) {
    const ixVersion = (await run(request, ['ix', '--version'])).stdout.trim();
    if (!ixVersion.split(/\s+/).includes(request.environment.ix_version)) throw new Error('Ix CLI version differs from pin');
    const files = { ...integrationFiles(request), ...await pinnedSkills(request) };
    for (const [path, expected] of Object.entries(files)) {
      if (readFileSync(path, 'utf8') !== expected) throw new Error(`Integration content differs: ${path}`);
      evidence.push({ path, sha256: sha256(expected) });
    }
    // Exercise the configured hook executable; config presence alone is insufficient.
    await run(request, [process.execPath, join(root, 'hook.mjs'), 'probe']);
    const status = JSON.parse((await run(request, ['ix', 'status', '--format', 'json', '--root', request.repo_path])).stdout);
    const stats = JSON.parse((await run(request, ['ix', 'stats', '--format', 'json'])).stdout);
    assertMapped(status, stats);
    for (const [name, data] of [['map-status.json', status], ['map-stats.json', stats]]) {
      const path = join(request.run_path, name); write(path, json(data)); evidence.push({ path, sha256: sha256(json(data)) });
    }
  } else {
    if (existsSync(join(request.run_path, 'plugin')) || existsSync(join(request.home, '.codex', 'config.toml'))) throw new Error('Baseline contains Ix integration');
  }
  return { version: 1, repo_path: request.repo_path, base_commit: head, agent_version: request.agent.version,
    ix_available: available, mapped: ix, plugin_installed: ix, skills_installed: ix, hooks_enabled: ix,
    ...(ix ? { mapped_commit: head, plugin_revision: request.environment.plugin_revision } : {}), evidence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [stage, file] = process.argv.slice(2), request = JSON.parse(readFileSync(file, 'utf8'));
    if (stage === 'setup') await setup(request);
    else if (stage === 'probe') console.log(json(await probe(request)));
    else throw new Error('Usage: provision.mjs setup|probe REQUEST.json');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
