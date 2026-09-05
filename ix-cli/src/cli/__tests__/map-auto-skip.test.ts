import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hostname } from 'node:os';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyRequestedMapCoalesceExitCode,
  describeDroppedFiles,
  describeEmptyCompletedMap,
  describeRegionlessCompletedMap,
  invalidateBaselineForIncompleteCompletedMap,
  mapModeForIngest,
  registerMapCommand,
  requestedMapCoalesceExitCode,
  shouldSkipAutoMap,
} from '../commands/map.js';
import { lockPathForTest } from '../single-flight.js';

describe('shouldSkipAutoMap', () => {
  afterEach(() => { delete process.env.IX_AUTO_MAP_CLOUD; });

  it('skips an automatic map against a remote backend', () => {
    expect(shouldSkipAutoMap({ auto: true, cloudReady: true })).toBe(true);
  });

  it('never skips a manual map (auto=false), even against a remote backend', () => {
    expect(shouldSkipAutoMap({ auto: false, cloudReady: true })).toBe(false);
  });

  it('never skips an automatic map against a local backend', () => {
    expect(shouldSkipAutoMap({ auto: true, cloudReady: false })).toBe(false);
  });

  it('honors the IX_AUTO_MAP_CLOUD opt-in to allow remote auto-refresh', () => {
    process.env.IX_AUTO_MAP_CLOUD = '1';
    expect(shouldSkipAutoMap({ auto: true, cloudReady: true })).toBe(false);
  });
});

describe('requestedMapCoalesceExitCode', () => {
  it('accepts a private non-zero process exit code', () => {
    expect(requestedMapCoalesceExitCode('75')).toBe(75);
  });

  it.each([undefined, '', '0', '256', '1.5', 'nope'])('ignores invalid value %s', value => {
    expect(requestedMapCoalesceExitCode(value)).toBeUndefined();
  });

  it('applies the requested exit code on the map-lock coalesce path', () => {
    let applied: number | undefined;

    expect(applyRequestedMapCoalesceExitCode('75', code => { applied = code; })).toBe(true);
    expect(applied).toBe(75);
  });

  it('preserves normal exit behavior when the private option is absent', () => {
    const apply = vi.fn();

    expect(applyRequestedMapCoalesceExitCode(undefined, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('makes the real map action exit before ingest when its lock is contended', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ix-map-coalesce-'));
    const root = path.join(lockDir, 'workspace');
    fs.mkdirSync(root);
    process.env.IX_LOCK_DIR = lockDir;
    process.env.IX_MAP_COALESCE_EXIT_CODE = '75';
    fs.writeFileSync(lockPathForTest(root), JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: Date.now(),
      label: 'held by test',
    }));

    try {
      const program = new Command();
      registerMapCommand(program);
      await program.parseAsync(['node', 'ix', 'map', root, '--silent']);
      expect(process.exitCode).toBe(75);
    } finally {
      process.exitCode = undefined;
      delete process.env.IX_LOCK_DIR;
      delete process.env.IX_MAP_COALESCE_EXIT_CODE;
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

describe('mapModeForIngest', () => {
  it('keeps ordinary map ingestion topology-only', () => {
    expect(mapModeForIngest(undefined)).toBe(true);
  });

  it('lets watch request full canonical patches after the map lock is acquired', () => {
    expect(mapModeForIngest('1')).toBe(false);
  });
});

describe('describeEmptyCompletedMap', () => {
  const emptyResult = {
    file_count: 0,
    region_count: 0,
    regions: [],
    outcome: 'full_local_completed',
  };

  it('rejects a completed empty map after a clean ingest committed source patches', () => {
    const message = describeEmptyCompletedMap(emptyResult, {
      filesDiscovered: 260,
      patchesApplied: 260,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    });

    expect(message).toContain('mapped 0 files after local ingest found 260 supported source files');
    expect(message).toContain('(260 patches committed)');
    expect(message).toContain('no architecture hierarchy was created');
    expect(message).toContain("the next 'ix map' can reuse unchanged files");
  });

  it('blames deduplication, not the language, when every commit was a replay (#527)', () => {
    const message = describeEmptyCompletedMap(emptyResult, {
      filesDiscovered: 1,
      patchesApplied: 1,
      idempotentPatches: 1,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    });

    expect(message).toContain("answered every one of the 1 committed patch with 'already applied'");
    expect(message).toContain('this run wrote nothing');
    expect(message).toContain('expire within 24 hours');
    // The old diagnosis is actively wrong here: the source parsed fine, and
    // nothing about it reached the backend's graph to be mapped.
    expect(message).not.toContain('may not map this source language');
    expect(message).not.toContain('The source graph was ingested');
    expect(message).toContain("the next 'ix map' can reuse unchanged files");
  });

  it('does not blame deduplication when the run skipped files as unchanged', () => {
    // Joey's case on #570: a workspace on a language the backend cannot build a
    // hierarchy for. 99 files are mtime-clean and never submitted — which is
    // itself proof the backend still holds their source hashes, and so their
    // nodes. The user reverts one file to content ingested earlier, its patch id
    // matches a record that is still there, and the backend answers Idempotent.
    // Every patch this run submitted was a replay, but the graph is intact and
    // waiting 24 hours changes nothing.
    const message = describeEmptyCompletedMap(emptyResult, {
      filesDiscovered: 100,
      patchesApplied: 1,
      idempotentPatches: 1,
      filesSkippedAsUnchanged: 99,
      parseErrors: 0,
      commitErrors: 0,
    });

    expect(message).not.toContain('deduplicated');
    expect(message).not.toContain('expire within 24 hours');
    expect(message).toContain('may not map this source language');
  });

  it('keeps the language diagnosis when only some commits were replays', () => {
    const message = describeEmptyCompletedMap(emptyResult, {
      filesDiscovered: 10,
      patchesApplied: 10,
      idempotentPatches: 9,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    });

    expect(message).toContain('may not map this source language');
    expect(message).not.toContain("already applied");
  });

  it('does not claim deduplication when nothing was committed at all', () => {
    // patchesApplied 0 with files discovered is the hash-skip path, not a
    // replay; `idempotentPatches >= patchesApplied` is trivially true there.
    const message = describeEmptyCompletedMap(emptyResult, {
      filesDiscovered: 30,
      patchesApplied: 0,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    });

    expect(message).toContain('may not map this source language');
    expect(message).not.toContain("already applied");
  });

  it('does not reject an actually empty workspace', () => {
    expect(describeEmptyCompletedMap(emptyResult, {
      filesDiscovered: 0,
      patchesApplied: 0,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    })).toBeUndefined();
  });

  it('does not mask an ingest failure with a map-language diagnosis', () => {
    expect(describeEmptyCompletedMap(emptyResult, {
      filesDiscovered: 12,
      patchesApplied: 12,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 1,
      commitErrors: 0,
    })).toBeUndefined();
    expect(describeEmptyCompletedMap(emptyResult, {
      filesDiscovered: 12,
      patchesApplied: 12,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 1,
    })).toBeUndefined();
  });

  it('ignores an outcome the backend does not actually send', () => {
    // 'ok' was in the completed set but is not one of the six MapOutcome
    // labels, so it only ever looked like coverage.
    expect(describeEmptyCompletedMap({ ...emptyResult, outcome: 'ok' }, {
      filesDiscovered: 260,
      patchesApplied: 260,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    })).toBeUndefined();
  });

  it('leaves guardrail refusals alone, which carry no regions by design', () => {
    for (const outcome of ['local_map_too_large', 'local_map_not_recommended']) {
      expect(describeEmptyCompletedMap({ ...emptyResult, outcome }, {
        filesDiscovered: 260,
        patchesApplied: 260,
        idempotentPatches: 0,
        filesSkippedAsUnchanged: 0,
        parseErrors: 0,
        commitErrors: 0,
      })).toBeUndefined();
    }
  });

  it('requires both an explicitly completed outcome and an entirely empty response', () => {
    expect(describeEmptyCompletedMap({ ...emptyResult, outcome: 'local_map_not_recommended' }, {
      filesDiscovered: 12,
      patchesApplied: 12,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    })).toBeUndefined();
    expect(describeEmptyCompletedMap({ ...emptyResult, file_count: 12 }, {
      filesDiscovered: 12,
      patchesApplied: 12,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    })).toBeUndefined();
    expect(describeEmptyCompletedMap({ ...emptyResult, region_count: 1 }, {
      filesDiscovered: 12,
      patchesApplied: 12,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    })).toBeUndefined();
  });

  it('invalidates the architecture baseline, including on an unchanged retry', () => {
    const invalidate = vi.fn();
    const message = invalidateBaselineForIncompleteCompletedMap(emptyResult, {
      filesDiscovered: 260,
      patchesApplied: 0,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    }, '/workspace/account', invalidate);

    expect(message).toContain('(0 patches committed)');
    expect(message).toContain('source ingest baseline was preserved');
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith('/workspace/account');
  });

  it('rejects an empty cached map when coupling is reported unchanged', () => {
    expect(describeEmptyCompletedMap({ ...emptyResult, outcome: 'coupling_unchanged' }, {
      filesDiscovered: 260,
      patchesApplied: 0,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    })).toBeDefined();
  });
});

describe('describeRegionlessCompletedMap', () => {
  const cleanIngest = {
    filesDiscovered: 200,
    patchesApplied: 200,
    idempotentPatches: 0,
    filesSkippedAsUnchanged: 0,
    parseErrors: 0,
    commitErrors: 0,
  };

  it('rejects a completed response that counted files but built no regions', () => {
    const message = describeRegionlessCompletedMap({
      file_count: 100,
      region_count: 0,
      regions: [],
      outcome: 'full_local_completed',
    }, cleanIngest);

    expect(message).toContain('produced 0 regions while mapping 100 of 200 supported source files');
    expect(message).toContain('source ingest baseline was preserved');
  });

  it('accepts a hierarchy that covers only a minority of discovered files', () => {
    // #534: a real PHP workspace maps 381 regions' worth of files out of ~7,400
    // discovered, because .md/.json/.yaml/.css are discovered and never mapped.
    // A coverage ratio rejects that healthy map on every single run.
    expect(describeRegionlessCompletedMap({
      file_count: 381,
      region_count: 42,
      regions: [{ id: 'r1' } as any],
      outcome: 'full_local_completed',
    }, { ...cleanIngest, filesDiscovered: 7400, patchesApplied: 7400 })).toBeUndefined();
  });

  it('does not replace an ingest failure with a hierarchy diagnosis', () => {
    expect(describeRegionlessCompletedMap({
      file_count: 1,
      region_count: 0,
      regions: [],
      outcome: 'full_local_completed',
    }, { ...cleanIngest, commitErrors: 1 })).toBeUndefined();
  });

  it('leaves the empty-map case to its own diagnosis', () => {
    expect(describeRegionlessCompletedMap({
      file_count: 0,
      region_count: 0,
      regions: [],
      outcome: 'full_local_completed',
    }, cleanIngest)).toBeUndefined();
  });

  it('invalidates only the architecture baseline for a regionless hierarchy', () => {
    const invalidate = vi.fn();
    const message = invalidateBaselineForIncompleteCompletedMap({
      file_count: 1,
      region_count: 0,
      regions: [],
      outcome: 'full_local_completed',
    }, {
      filesDiscovered: 2,
      patchesApplied: 2,
      idempotentPatches: 0,
      filesSkippedAsUnchanged: 0,
      parseErrors: 0,
      commitErrors: 0,
    }, '/workspace/mixed', invalidate);

    expect(message).toContain('produced 0 regions while mapping 1 of 2');
    expect(invalidate).toHaveBeenCalledWith('/workspace/mixed');
  });
});

describe('describeDroppedFiles', () => {
  it('stays silent on a clean ingest', () => {
    expect(describeDroppedFiles({ parseErrors: 0, commitErrors: 0 })).toBeUndefined();
  });

  it('stays silent when there was no local ingest', () => {
    expect(describeDroppedFiles(undefined)).toBeUndefined();
  });

  it('reports files that failed to build a patch', () => {
    const message = describeDroppedFiles({ parseErrors: 48, commitErrors: 0 });

    // Not "the map is incomplete": persistCompletedMapBaseline runs either way,
    // so doctor answers "Completed map for this workspace" beside this line.
    expect(message).not.toContain('incomplete');
    expect(message).toContain('48 files failed to build a patch');
    expect(message).toContain('absent from the graph');
    expect(message).not.toContain('failed to commit');
  });

  it('reports commit failures', () => {
    const message = describeDroppedFiles({ parseErrors: 0, commitErrors: 3 });

    expect(message).toContain('3 patches failed to commit');
    expect(message).not.toContain('failed to build a patch');
  });

  it('reports both causes together', () => {
    const message = describeDroppedFiles({ parseErrors: 2, commitErrors: 5 });

    expect(message).toContain('2 files failed to build a patch');
    expect(message).toContain('5 patches failed to commit');
  });

  it('singularises a lone failure of each kind', () => {
    expect(describeDroppedFiles({ parseErrors: 1, commitErrors: 0 }))
      .toContain('1 file failed to build a patch');
    expect(describeDroppedFiles({ parseErrors: 0, commitErrors: 1 }))
      .toContain('1 patch failed to commit');
  });
});
