// Copyright 2026 Ix Infrastructure Inc.

import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export function findBinary(binary, searchPath = process.env.PATH) {
  const candidates = binary.includes('/') ? [resolve(binary)] : searchPath.split(delimiter).map((dir) => join(dir, binary));
  for (const file of candidates) {
    try { accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* next directory */ }
  }
  throw new Error(`Executable unavailable: ${binary}`);
}

/** A private executable directory, rather than a setup process attempting to export PATH. */
export function armEnvironment(request, inherited = process.env) {
  if (process.platform === 'win32') throw new Error('Arm isolation currently requires POSIX; use Linux for SWE-bench');
  const { home, run_path, arm, environment } = request;
  const bin = join(run_path, 'bin'); mkdirSync(bin);
  const seen = new Set();
  for (const dir of environment.tool_paths ?? inherited.PATH.split(delimiter)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name === 'ix' || name.startsWith('ix.') || seen.has(name)) continue;
      const file = join(dir, name);
      try { if (!statSync(file).isFile()) continue; accessSync(file, constants.X_OK); symlinkSync(resolve(file), join(bin, name)); seen.add(name); } catch { /* non-executable or duplicate */ }
    }
  }
  // The native adapter and hooks use this exact Node executable in both arms.
  if (!seen.has('node')) symlinkSync(process.execPath, join(bin, 'node'));
  const env = { ...inherited, PATH: bin, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), IX_HOME: join(home, '.ix'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    AGENT_EVAL_REQUEST: join(run_path, 'request.json') };
  for (const key of Object.keys(env)) if (/^(IX_|JARVIS_IX_|CLAUDE_CODE_|CLAUDE_PROJECT_|CODEX_THREAD_)/.test(key) && key !== 'IX_HOME') delete env[key];
  if (arm === 'ix' && environment.ix_cli) {
    env.IX_ENDPOINT = environment.endpoint;
    const launcher = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(environment.ix_cli)} "$@"\n`;
    writeFileSync(join(bin, 'ix'), launcher, { mode: 0o755 });
  }
  return env;
}

export const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
