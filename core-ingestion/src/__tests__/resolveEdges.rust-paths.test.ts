// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges, type FileParseResult } from '../index.js';

/**
 * Rust calls spelled through a module path. `stats::report()` names the
 * function `report` of the module `stats`, which is a file (`stats.rs` or
 * `stats/mod.rs`) found from where the module is declared, not a member of a
 * type called `stats`.
 */

const parse = (filePath: string, source: string): FileParseResult => parseFile(filePath, source)!;

const calls = (results: FileParseResult[]) =>
  resolveEdges(results)
    .filter(edge => edge.predicate === 'CALLS')
    .map(edge => [edge.srcFilePath, edge.srcName, edge.dstFilePath, edge.dstQualifiedKey, edge.confidence, edge.tier]);

const STATS = 'pub fn report() {}\npub struct Counter;\nimpl Counter {\n    pub fn build() -> Self { Counter }\n}\n';

describe('Rust module-path calls', () => {
  it('resolves module::func() through a mod declaration', () => {
    const main = parse('/repo/src/main.rs', 'mod stats;\n\nfn main() {\n    stats::report();\n}\n');
    const stats = parse('/repo/src/stats.rs', STATS);
    // Same name in a module the caller does not declare.
    const other = parse('/repo/src/other/stats.rs', 'pub fn report() {}\n');

    expect(main.importAliases).toEqual({ stats: 'self::stats' });
    expect(calls([main, stats, other])).toEqual([
      ['/repo/src/main.rs', 'main', '/repo/src/stats.rs', 'report', 0.9, 'qualifier'],
    ]);
  });

  it('finds a declared module in its mod.rs and below a non-root file', () => {
    const lib = parse('/repo/src/lib.rs', 'mod net;\n\npub fn start() {\n    net::open();\n}\n');
    const net = parse('/repo/src/net/mod.rs', 'mod tcp;\n\npub fn open() {\n    tcp::connect();\n}\n');
    const tcp = parse('/repo/src/net/tcp.rs', 'mod frame;\n\npub fn connect() {\n    frame::read();\n}\n');
    const frame = parse('/repo/src/net/tcp/frame.rs', 'pub fn read() {}\n');

    expect(calls([lib, net, tcp, frame])).toEqual(expect.arrayContaining([
      ['/repo/src/lib.rs', 'start', '/repo/src/net/mod.rs', 'open', 0.9, 'qualifier'],
      ['/repo/src/net/mod.rs', 'open', '/repo/src/net/tcp.rs', 'connect', 0.9, 'qualifier'],
      ['/repo/src/net/tcp.rs', 'connect', '/repo/src/net/tcp/frame.rs', 'read', 0.9, 'qualifier'],
    ]));
  });

  it('resolves module::func() through a use of the module', () => {
    const main = parse('/repo/src/main.rs', 'mod stats;\nmod other;\n');
    const stats = parse('/repo/src/stats.rs', STATS);
    const other = parse(
      '/repo/src/other.rs',
      'use crate::stats;\nuse super::stats as totals;\nuse crate::{stats as grouped, stats::Counter};\n\n'
        + 'pub fn via_use() {\n    stats::report();\n}\n'
        + 'pub fn via_alias() {\n    totals::report();\n}\n'
        + 'pub fn via_group() {\n    grouped::report();\n}\n'
        + 'pub fn via_type() {\n    Counter::build();\n}\n',
    );

    expect(calls([main, stats, other])).toEqual(expect.arrayContaining([
      ['/repo/src/other.rs', 'via_use', '/repo/src/stats.rs', 'report', 0.9, 'qualifier'],
      ['/repo/src/other.rs', 'via_alias', '/repo/src/stats.rs', 'report', 0.9, 'qualifier'],
      ['/repo/src/other.rs', 'via_group', '/repo/src/stats.rs', 'report', 0.9, 'qualifier'],
      ['/repo/src/other.rs', 'via_type', '/repo/src/stats.rs', 'Counter.build', 0.9, 'qualifier'],
    ]));
  });

  it('resolves a call spelled with its full path', () => {
    const main = parse('/repo/src/main.rs', 'mod stats;\nmod other;\n');
    const stats = parse('/repo/src/stats.rs', STATS);
    const other = parse(
      '/repo/src/other.rs',
      'pub fn via_crate_path() {\n    crate::stats::report();\n}\n'
        + 'pub fn via_super_path() {\n    super::stats::report();\n}\n'
        + 'pub fn via_type_path() {\n    crate::stats::Counter::build();\n}\n',
    );

    expect(other.relationships).toContainEqual({ srcName: 'via_crate_path', dstName: 'crate.stats.report', predicate: 'CALLS' });
    expect(calls([main, stats, other])).toEqual(expect.arrayContaining([
      ['/repo/src/other.rs', 'via_crate_path', '/repo/src/stats.rs', 'report', 0.9, 'qualifier'],
      ['/repo/src/other.rs', 'via_super_path', '/repo/src/stats.rs', 'report', 0.9, 'qualifier'],
      ['/repo/src/other.rs', 'via_type_path', '/repo/src/stats.rs', 'Counter.build', 0.9, 'qualifier'],
    ]));
  });

  it('leaves a path into another crate unresolved', () => {
    const main = parse('/repo/src/main.rs', 'use std::fs;\n\nfn main() {\n    fs::read();\n    std::fs::read();\n    clap::read();\n}\n');
    const fs = parse('/repo/src/fs.rs', 'pub fn read() {}\n');

    expect(main.importAliases).toBeUndefined();
    expect(calls([main, fs])).toEqual([]);
  });
});
