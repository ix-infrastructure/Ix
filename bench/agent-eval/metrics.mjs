// Copyright 2026 Ix Infrastructure Inc.

export const METRICS = ['resolved', 'input_tokens', 'output_tokens', 'cached_tokens', 'turns', 'tool_calls', 'search_calls', 'rg_calls', 'grep_calls', 'find_calls', 'native_search_calls', 'ix_calls', 'ix_errors', 'hook_ix_calls', 'hook_ix_errors', 'wall_seconds', 'hook_seconds', 'setup_seconds', 'eval_seconds', 'total_wall_seconds'];
const counter = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing or invalid ${label}`);
  return value;
};

/** Token ceiling usage: uncached input plus output, comparable across Claude and Codex.
 * Cache reads re-send context already counted and would otherwise dominate long sessions.
 */
export const budgetTokens = (usage) => usage.input_tokens - usage.cached_tokens + usage.output_tokens;

/** Tokenize direct shell commands, preserving quoted separators as argument text.
 * `separators[i]` holds the control operators between commands i and i + 1; `trailing` those after the last.
 * Scripts, aliases and dynamic expansions require normalized tool telemetry.
 * Never throws: an unbalanced quote keeps what was parsed, so one malformed agent command cannot stop a run.
 */
function shellCommands(text) {
  const commands = [], separators = [], heredocs = []; let words = [], word = '', quote = '', active = false, operators = '';
  const flush = () => { if (active) words.push(word); word = ''; active = false; };
  const boundary = () => {
    flush();
    if (words.length) { if (commands.length) separators.push(operators); operators = ''; commands.push(words); }
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") {
      if (text[i + 1] !== '\n') { word += text[++i] ?? ''; active = true; } else i++;
    } else if (quote) {
      // ANSI-C `$'...'` closes on a single quote but, unlike '...', honours backslash escapes (above).
      if (c === quote.at(-1)) quote = ''; else word += c;
    } else if (c === '$' && text[i + 1] === "'") { quote = "$'"; active = true; i++; }
    else if (c === "'" || c === '"') { quote = c; active = true; }
    else if (c === '#' && !active) { while (i < text.length && text[i] !== '\n') i++; i--; }
    else if (text.startsWith('<<<', i)) { flush(); i += 2; } // A here-string is a single word of input.
    else if (text.startsWith('<<', i)) {
      // Heredoc bodies are data (scripts, fixtures), never commands; skip them at the next newline.
      flush(); i += 2;
      const strip = text[i] === '-'; if (strip) i++;
      while (text[i] === ' ' || text[i] === '\t') i++;
      let delimiter = '';
      for (; i < text.length && !/[\s;&|()<>]/.test(text[i]); i++) if (!`'"\\`.includes(text[i])) delimiter += text[i];
      i--;
      if (delimiter) heredocs.push({ delimiter, strip });
    } else if (c === '\n' && heredocs.length) {
      boundary(); operators += c;
      for (const { delimiter, strip } of heredocs.splice(0)) {
        let end = i;
        do {
          const start = end + 1; end = text.indexOf('\n', start); if (end < 0) end = text.length;
          const line = text.slice(start, end);
          if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break;
        } while (end < text.length);
        i = end;
      }
    }
    // `>&`, `<&` and `&>` are redirections, not background/list operators.
    else if (c === '&' && ('<>'.includes(text[i - 1]) || text[i + 1] === '>')) { word += c; active = true; }
    else if (';&|\n'.includes(c)) { boundary(); operators += c; }
    else if ('()'.includes(c)) boundary();
    else if (/\s/.test(c)) flush();
    else { word += c; active = true; }
  }
  boundary(); return { commands, separators, trailing: operators };
}
/** The program a command runs, and the script it hands to `sh`/`bash`/`zsh -c` (native Codex wraps commands in bash -lc). */
function program(words) {
  let i = 0;
  if (words[i] === 'env') i++;
  while (/^[A-Za-z_][\w]*=/.test(words[i] ?? '')) i++;
  while (['command', 'exec'].includes(words[i])) i++;
  const name = words[i]?.split('/').at(-1);
  const script = ['sh', 'bash', 'zsh'].includes(name) && /^-[a-z]*c[a-z]*$/.test(words[i + 1] ?? '') ? words[i + 2] ?? '' : undefined;
  return { name, script };
}
export function commandCounts(command) {
  const counts = { search_calls: 0, rg_calls: 0, grep_calls: 0, find_calls: 0, ix_calls: 0 };
  for (const words of shellCommands(command).commands) {
    const { name, script } = program(words);
    if (['rg', 'grep', 'find', 'ix'].includes(name)) {
      counts[`${name}_calls`]++; if (name !== 'ix') counts.search_calls++;
    }
    if (script !== undefined) {
      const nested = commandCounts(script);
      for (const key of Object.keys(counts)) counts[key] += nested[key];
    }
  }
  return counts;
}

/** What a command's exit status says about the `ix` calls in it.
 * `sole`: the command is one `ix` invocation, so its failure is an Ix failure (`ix map && npm test` failing is not).
 * `confirmed`: an `&&` chain containing `ix`, so its success means `ix` ran and succeeded
 * (`ix … || echo`, `ix … | head`, `ix …; echo` and `ix … &` succeed even when `ix` never ran).
 */
export function ixExitScope(command) {
  const { commands, separators, trailing } = shellCommands(command);
  // A newline after `&&` continues the chain; a bare newline is a `;`.
  const chained = separators.every((ops) => ops.replace(/\n/g, '') === '&&') && !/[&|]/.test(trailing);
  const scopes = commands.map((words) => {
    const { name, script } = program(words);
    return name === 'ix' ? { sole: true, confirmed: true } : script !== undefined ? ixExitScope(script) : { sole: false, confirmed: false };
  });
  return { sole: chained && scopes.length === 1 && scopes[0].sole, confirmed: chained && scopes.some((scope) => scope.confirmed) };
}

// Claude Code's built-in search tools; they run no shell command, so commandCounts never sees them.
const CLAUDE_SEARCH_TOOLS = new Set(['Grep', 'Glob']);

/** Claude names MCP tools `mcp__<server>__<tool>`; plugin servers (our `--plugin-dir`
 * arm) become `mcp__plugin_<plugin>_<server>__<tool>`. Plugin names are kebab-case.
 */
export function isIxMcpTool(name) {
  const server = /^mcp__(.+?)__/.exec(name ?? '')?.[1] ?? '';
  return /^(?:plugin_[a-z0-9-]+_)?ix(?:[._-]|$)/i.test(server);
}

// Claude's tool_result text when --print denies a tool that was not allowed.
const CLAUDE_DENIAL = /requested permissions to use .*(?:haven't|have not) granted/is;
// bash/dash/zsh/env messages for an `ix` that could not be started.
const IX_MISSING = /(?:^|[\s'"/])ix'?: (?:(?:command )?not found|No such file or directory)|command not found: ix(?:\s|$)/m;

function ixErrorCode(text) {
  try { return JSON.parse(text).error?.code; } catch {
    return String(text ?? '').match(/(?:^|\n)error\s+code=(?:"([\w.-]+)"|([\w.-]+))/)?.slice(1).find(Boolean);
  }
}
/** An Ix failure visible in the output, even when `2>&1 | head` or `|| fallback` made the command exit 0. */
function ixFailureCode(text) {
  return ixErrorCode(text) ?? (IX_MISSING.test(String(text ?? '')) ? 'COMMAND_NOT_FOUND' : undefined);
}
const resultText = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('\n') : '';

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
  const turns = new Set(), tools = new Set(), ixTools = new Set(), failedTools = new Set(), ixDenied = new Set(), errors = Object.create(null);
  // Ix tool calls whose exit status is Ix's own (soleIx) or proves Ix succeeded (confirmedIx); nonzero: tools that exited nonzero.
  const soleIx = new Set(), confirmedIx = new Set(), nonzero = new Set();
  let search_calls = 0, rg_calls = 0, grep_calls = 0, find_calls = 0, native_search_calls = 0, ix_calls = 0, permission_denials = 0;
  const tool = (id, command = '', isIx = false, nativeSearch = false) => {
    if (!id) throw new Error('Tool event missing id');
    if (tools.has(id)) return;
    tools.add(id);
    const counts = commandCounts(command);
    search_calls += counts.search_calls + Number(nativeSearch); native_search_calls += Number(nativeSearch);
    rg_calls += counts.rg_calls; grep_calls += counts.grep_calls; find_calls += counts.find_calls;
    ix_calls += counts.ix_calls + Number(isIx);
    if (counts.ix_calls || isIx) {
      ixTools.add(id);
      const scope = isIx ? { sole: true, confirmed: true } : ixExitScope(command);
      if (scope.sole) soleIx.add(id);
      if (scope.confirmed) confirmedIx.add(id);
    }
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
        if (content.type === 'tool_result' && ixTools.has(content.tool_use_id)) {
          const text = resultText(content.content), code = ixFailureCode(text);
          // A permission denial is a harness misconfiguration, not an Ix failure.
          if (content.is_error && CLAUDE_DENIAL.test(text)) ixDenied.add(content.tool_use_id);
          else {
            if (content.is_error) nonzero.add(content.tool_use_id);
            if (code || (content.is_error && soleIx.has(content.tool_use_id))) toolError(content.tool_use_id, code);
          }
        }
      }
      if (event.type === 'assistant') {
        if (!event.message?.id) throw new Error('Assistant event missing message id');
        // A subagent's messages (Task/Explore) carry the id of the tool call that started it. They are not turns of the
        // main agent, which is what --max-turns limits; their tool calls still count below.
        if (!event.parent_tool_use_id && event.isSidechain !== true) turns.add(event.message.id);
        for (const content of event.message.content ?? []) {
          if (content.type === 'tool_use') tool(content.id, content.input?.command ?? '', isIxMcpTool(content.name), CLAUDE_SEARCH_TOOLS.has(content.name));
        }
      }
      if (event.type === 'result') {
        if (event.subtype === 'error_max_turns') budgetReason = 'turn_budget';
        for (const denial of event.permission_denials ?? []) {
          permission_denials++;
          if (isIxMcpTool(denial.tool_name) || commandCounts(denial.tool_input?.command ?? '').ix_calls) ixDenied.add(denial.tool_use_id ?? denial.tool_name);
        }
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
          const code = ixFailureCode(item.aggregated_output), failed = item.exit_code !== 0 && item.exit_code != null;
          if (failed) nonzero.add(item.id);
          if (ixTools.has(item.id) && (code || (failed && soleIx.has(item.id)))) toolError(item.id, code);
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
    // Ix calls that certainly ran and succeeded: an Ix MCP call or an `&&` chain with `ix` that exited 0, with no Ix failure
    // in its output. Normalized telemetry has no per-call outcome, so its confirmed calls all count.
    ix_succeeded: [...confirmedIx].filter((id) => !nonzero.has(id) && !failedTools.has(id) && !ixDenied.has(id)).length,
    turns: turns.size, tool_calls: tools.size, ix_permission_denials: ixDenied.size, permission_denials, search_calls, rg_calls, grep_calls, find_calls, native_search_calls, ix_calls,
    ix_errors: Object.values(errors).reduce((a, b) => a + b, 0), ix_errors_by_code: { ...errors } };
}
