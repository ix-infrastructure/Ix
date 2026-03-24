/**
 * Worker thread entry point for parallel file parsing.
 * Each worker maintains its own Parser singleton (safe — module state is per-thread).
 * Receives: { filePath: string, source: string }
 * Posts:    { ok: true, result: FileParseResult } | { ok: false }
 */
import { parentPort } from 'node:worker_threads';
import { parseFile } from './index.js';

if (!parentPort) throw new Error('parse-worker must run inside a worker thread');

parentPort.on('message', ({ filePath, source }: { filePath: string; source: string }) => {
  try {
    const result = parseFile(filePath, source);
    parentPort!.postMessage({ ok: result !== null, result: result ?? null });
  } catch {
    parentPort!.postMessage({ ok: false, result: null });
  }
});
