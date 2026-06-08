import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const coreIngestionDir = resolve(process.cwd(), '../core-ingestion');
const nodeModules = resolve(coreIngestionDir, 'node_modules');

// Reinstall only when deps are missing (or when forced). This makes the build
// idempotent: a cached node_modules (CI cache hit, or a normal local checkout)
// skips the native tree-sitter recompile, which is the slowest and most
// failure-prone step. Set IX_FORCE_INSTALL=1 to force a clean `npm ci`.
if (process.env.IX_FORCE_INSTALL === '1' || !existsSync(nodeModules)) {
  execSync(`${npmCmd} ci --silent`, {
    cwd: coreIngestionDir,
    shell: true,
    stdio: 'inherit',
  });
}

execSync(`${npmCmd} run build`, {
  cwd: coreIngestionDir,
  shell: true,
  stdio: 'inherit',
});
