// Copyright 2026 Ix Infrastructure Inc.

// Names shared by provisioning, the native agent argv and telemetry.
export const PLUGIN_NAME = 'ix-agent-eval';
export const MCP_SERVER = 'ix-memory';
// Claude names plugin MCP tools `mcp__plugin_<plugin>_<server>__<tool>`; a server-level rule allows all of them.
export const CLAUDE_IX_MCP_RULE = `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER}`;

// Arm integrations (plugins, MCP, settings, hooks, tool permissions) belong to the harness, never to shared args.
const OVERRIDES = /plugin|mcp|settings|notify|allowed-?tools|CODEX_HOME|CLAUDE_CONFIG_DIR/i;

export function extraArgs(agent) {
  const extra = agent.args ?? [];
  if (!Array.isArray(extra) || extra.some((v) => typeof v !== 'string')) throw new Error('agent.args must be an argv array');
  if (extra.some((arg) => OVERRIDES.test(arg))) throw new Error('agent.args must not override arm integrations; use agent.allowed_tools for shared tool permissions');
  return extra;
}

/** Shared Claude tool rules; the harness adds the Ix MCP rule for the ix arm only. */
export function allowedTools(agent) {
  const tools = agent.allowed_tools ?? [];
  if (!Array.isArray(tools) || tools.some((v) => typeof v !== 'string' || !v.trim() || v.includes(','))) throw new Error('agent.allowed_tools must be an array of tool rules without commas');
  if (tools.length && agent.family !== 'claude') throw new Error('agent.allowed_tools is supported for Claude Code only');
  if (tools.some((tool) => /mcp|plugin/i.test(tool))) throw new Error('agent.allowed_tools must not grant MCP tools; the ix arm integration does');
  return tools;
}

export function nativeArgs(request) {
  const { agent, budget } = request, extra = extraArgs(agent);
  if (agent.family === 'codex') {
    allowedTools(agent);
    return ['exec', '--json', '--model', agent.model, '-c', `model_reasoning_effort=${JSON.stringify(agent.effort)}`, ...extra, '-'];
  }
  if (agent.family !== 'claude') throw new Error('Unsupported native agent');
  const ix = request.arm === 'ix';
  const tools = [...allowedTools(agent), ...(ix ? [CLAUDE_IX_MCP_RULE] : [])];
  const integration = ['--setting-sources', '', ...(ix ? ['--plugin-dir', request.run_path + '/plugin'] : ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'])];
  return ['--print', '--verbose', '--output-format', 'stream-json', '--model', agent.model, '--effort', agent.effort, '--max-turns', String(budget.max_turns),
    ...integration, ...(tools.length ? ['--allowedTools', tools.join(',')] : []), ...extra];
}
