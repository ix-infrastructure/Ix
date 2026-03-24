import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const coreIngestionDir = resolve(process.cwd(), '../core-ingestion');

execSync(`${npmCmd} ci --silent`, {
  cwd: coreIngestionDir,
  shell: true,
  stdio: 'inherit',
});

execSync(`${npmCmd} run build`, {
  cwd: coreIngestionDir,
  shell: true,
  stdio: 'inherit',
});
