// Copyright 2026 Ix Infrastructure Inc.

export const METRICS = ['resolved', 'input_tokens', 'output_tokens', 'cached_tokens', 'turns', 'tool_calls', 'search_calls', 'rg_calls', 'grep_calls', 'find_calls', 'ix_calls', 'ix_errors', 'wall_seconds', 'hook_seconds', 'setup_seconds', 'eval_seconds', 'total_wall_seconds'];
const counter = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing or invalid ${label}`);
  return value;
};

/** Token ceiling usage: uncached input plus output, comparable across Claude and Codex.
 * Cache reads re-send context already counted and would otherwise dominate long sessions.
 */
export const budgetTokens = (usage) => usage.input_tokens - usage.cached_tokens + usage.output_tokens;

/** Tokenize direct shell commands, preserving quoted separators as argument text.
 * Scripts, aliases and dynamic expansions require normalized tool telemetry.
 */
function shellCommands(text) {
  const commands = []; let words = [], word = '', quote = '', active = false;
  const flush = () => { if (active) words.push(word); word = ''; active = false; };
  const boundary = () => { flush(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") {
      if (text[i + 1] !== '\n') { word += text[++i] ?? ''; active = true; } else i++;
    } else if (quote) {
      if (c === quote) quote = ''; else word += c;
    } else if (c === "'" || c === '"') { quote = c; active = true; }
    else if (c === '#' && !active) { while (i < text.length && text[i] !== '\n') i++; boundary(); }
    else if (';&|\n()'.includes(c)) boundary();
    else if (/\s/.test(c)) flush();
    else { word += c; active = true; }
  }
  if (quote) throw new Error('Unterminated shell quote in tool telemetry');
  boundary(); return commands;
}
export function commandCounts(command) {
  const counts = { search_calls: 0, rg_calls: 0, grep_calls: 0, find_calls: 0, ix_calls: 0 };
  for (const words of shellCommands(command)) {
    let i = 0;
    if (words[i] === 'env') i++;
    while (/^[A-Za-z_][\w]*=/.test(words[i] ?? '')) i++;
    while (['command', 'exec'].includes(words[i])) i++;
    const name = words[i]?.split('/').at(-1);
    if (['rg', 'grep', 'find', 'ix'].includes(name)) {
      counts[`${name}_calls`]++; if (name !== 'ix') counts.search_calls++;
    }
    // Native Codex command events commonly wrap the actual script in bash -lc.
    if (['sh', 'bash', 'zsh'].includes(name) && /^-[a-z]*c[a-z]*$/.test(words[i + 1] ?? '')) {
      const nested = commandCounts(words[i + 2] ?? '');
      for (const key of Object.keys(counts)) counts[key] += nested[key];
    }
  }
  return counts;
}

/** Claude names MCP tools `mcp__<server>__<tool>`; plugin servers (our `--plugin-dir`
 * arm) become `mcp__plugin_<plugin>_<server>__<tool>`. Plugin names are kebab-case.
 */
export function isIxMcpTool(name) {
  const server = /^mcp__(.+?)__/.exec(name ?? '')?.[1] ?? '';
  return /^(?:plugin_[a-z0-9-]+_)?ix(?:[._-]|$)/i.test(server);
}

function ixErrorCode(text) {
  try { return JSON.parse(text).error?.code; } catch {
    return String(text ?? '').match(/(?:^|\n)error\s+code=(?:"([\w.-]+)"|([\w.-]+))/)?.slice(1).find(Boolean);
  }
}

/** Strict by default; budget-interrupted totals remain unknown, never fabricated zeroes. */
export function parseMetrics(text, format, { allowIncomplete = false } = {}) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean), events = []; let truncated = false;
  for (const [i, line] of lines.entries()) {
    try { events.push(JSON.parse(line)); } catch (error) {
      if (!allowIncomplete || i !== lines.length - 1) throw error;
      truncated = true; // A deadline can interrupt the last JSONL write.
    }
  }
  if (!['normalized', 'claude', 'codex'].includes(format)) throw new Error('Unknown telemetry format');
  let usage;
  const turns = new Set(), tools = new Set(), ixTools = new Set(), failedTools = new Set(), errors = Object.create(null);
  let search_calls = 0, rg_calls = 0, grep_calls = 0, find_calls = 0, ix_calls = 0;
  const tool = (id, command = '', isIx = false) => {
    if (!id) throw new Error('Tool event missing id');
    if (tools.has(id)) return;
    tools.add(id);
    const counts = commandCounts(command);
    search_calls += counts.search_calls; rg_calls += counts.rg_calls; grep_calls += counts.grep_calls; find_calls += counts.find_calls;
    ix_calls += counts.ix_calls + Number(isIx);
    if (counts.ix_calls || isIx) ixTools.add(id);
  };
  const ixError = (code) => { const key = String(code ?? 'unknown'); errors[key] = (errors[key] ?? 0) + 1; };
  const toolError = (id, code) => { if (!failedTools.has(id)) { failedTools.add(id); ixError(code); } };
  let completed = false, budgetReason;
  for (const event of events) {
    if (event.type === 'ix_error') ixError(event.code);
    if (format === 'normalized') {
      if (event.type === 'turn') { if (!event.id) throw new Error('Missing turn id'); turns.add(event.id); }
      if (event.type === 'tool') tool(event.id, event.command, event.ix === true);
      if (event.type === 'usage') {
        if (usage) throw new Error('Duplicate normalized usage');
        usage = { input_tokens: event.input_tokens, output_tokens: event.output_tokens, cached_tokens: event.cached_tokens };
      }
      if (event.type === 'done') completed = true;
    }
    if (format === 'claude') {
      if (event.type === 'user') for (const content of event.message?.content ?? []) {
        if (content.type === 'tool_result' && content.is_error && ixTools.has(content.tool_use_id)) {
          const code = ixErrorCode(typeof content.content === 'string' ? content.content : content.content?.[0]?.text);
          toolError(content.tool_use_id, code);
        }
      }
      if (event.type === 'assistant') {
        if (!event.message?.id) throw new Error('Assistant event missing message id');
        turns.add(event.message.id);
        for (const content of event.message.content ?? []) {
          if (content.type === 'tool_use') tool(content.id, content.input?.command ?? '', isIxMcpTool(content.name));
        }
      }
      if (event.type === 'result') {
        if (event.subtype === 'error_max_turns') budgetReason = 'turn_budget';
        if (budgetReason && !event.usage) { completed = true; continue; }
        if (usage) throw new Error('Duplicate Claude result');
        const u = event.usage ?? {};
        const fresh = counter(u.input_tokens, 'input_tokens');
        const cached = counter(u.cache_read_input_tokens, 'cache_read_input_tokens');
        const created = counter(u.cache_creation_input_tokens, 'cache_creation_input_tokens');
        usage = { input_tokens: fresh + cached + created, output_tokens: u.output_tokens, cached_tokens: cached };
        completed = true;
      }
    }
    if (format === 'codex') {
      if (event.type === 'turn.started') turns.add(`turn-${turns.size}`);
      if (event.type === 'item.completed') {
        const item = event.item;
        if (item?.type === 'command_execution') {
          tool(item.id, item.command);
          if (ixTools.has(item.id) && item.exit_code !== 0 && item.exit_code != null) {
            const code = ixErrorCode(item.aggregated_output);
            toolError(item.id, code);
          }
        }
        if (item?.type === 'mcp_tool_call') tool(item.id, '', /^ix(?:[._-]|$)/.test(item.server ?? ''));
        if (['file_change', 'web_search'].includes(item?.type)) tool(item.id);
        if (item?.type === 'mcp_tool_call' && /^ix(?:[._-]|$)/.test(item.server ?? '') && item.error) toolError(item.id, item.error.code);
      }
      if (event.type === 'turn.completed') {
        const u = event.usage ?? {};
        const delta = { input_tokens: counter(u.input_tokens, 'input_tokens'), output_tokens: counter(u.output_tokens, 'output_tokens'), cached_tokens: counter(u.cached_input_tokens, 'cached_input_tokens') };
        usage ??= { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
        for (const key of Object.keys(delta)) usage[key] += delta[key];
        completed = true;
      }
      if (event.type === 'turn.failed' || event.type === 'error') throw new Error('Agent failed; transcript is incomplete');
    }
  }
  const terminal = { normalized: 'done', claude: 'result', codex: 'turn.completed' }[format];
  const complete = Boolean(completed && usage && turns.size && !truncated && events.at(-1)?.type === terminal);
  if (!complete && !allowIncomplete && !budgetReason) throw new Error('Incomplete transcript: terminal event, turns and usage required');
  if (usage) {
    for (const key of ['input_tokens', 'output_tokens', 'cached_tokens']) counter(usage[key], key);
    if (usage.cached_tokens > usage.input_tokens) throw new Error('Cached tokens exceed total input tokens');
  }
  // Partial usage is a lower bound, never silently billed as a complete total.
  const tokens = complete ? usage : { input_tokens: null, output_tokens: null, cached_tokens: null };
  return { ...tokens, usage_complete: complete, telemetry_complete: complete, observed_usage: usage ?? null, budget_reason: budgetReason ?? null,
    turns: turns.size, tool_calls: tools.size, search_calls, rg_calls, grep_calls, find_calls, ix_calls,
    ix_errors: Object.values(errors).reduce((a, b) => a + b, 0), ix_errors_by_code: { ...errors } };
}
