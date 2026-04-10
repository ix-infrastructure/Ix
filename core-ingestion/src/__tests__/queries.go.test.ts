import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('Go queries', () => {
  it('captures structs, interfaces, functions, methods, and imports', () => {
    const result = parseFile(
      '/repo/service.go',
      `
package service

import "fmt"

type Service struct {
  name string
}

type Runner interface {
  Run()
}

func NewService(name string) *Service {
  return &Service{name: name}
}

func (s *Service) Run() {
  fmt.Println(s.name)
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['Service', 'Runner', 'NewService', 'Run']),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'service.go',
      dstName: 'fmt',
      predicate: 'IMPORTS',
    });

    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'Run', kind: 'method', container: 'Service' }),
    );
    expect(result!.chunks).toContainEqual(
      expect.objectContaining({ name: 'Run', chunkKind: 'method', container: 'Service' }),
    );
  });

  it('captures REFERENCES edges for pointer-typed struct fields (Bug 2)', () => {
    const result = parseFile(
      '/repo/manager.go',
      `
package scrape

type Manager struct {
  opts        *Options
  appendable  Appendable
  pool        *scrapePool
}
      `,
    );

    expect(result).not.toBeNull();

    // Bare type field — already worked before the fix
    expect(result!.relationships).toContainEqual({
      srcName: 'Manager',
      dstName: 'Appendable',
      predicate: 'REFERENCES',
    });

    // Pointer-typed fields — required Bug 2 fix
    expect(result!.relationships).toContainEqual({
      srcName: 'Manager',
      dstName: 'Options',
      predicate: 'REFERENCES',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Manager',
      dstName: 'scrapePool',
      predicate: 'REFERENCES',
    });
  });

  it('captures qualified CALLS edges for package-qualified calls (Bug 3)', () => {
    const result = parseFile(
      '/repo/main.go',
      `
package main

import (
  "github.com/example/scrape"
  "github.com/example/notifier"
  "github.com/example/promql"
)

func main() {
  queryEngine := promql.NewEngine(opts)
  scrapeManager, err := scrape.NewManager(cfg, logger)
  notifierManager := notifier.NewManager(cfg)
  _ = queryEngine
  _ = scrapeManager
  _ = notifierManager
  _ = err
}
      `,
    );

    expect(result).not.toBeNull();

    // All three package-qualified calls must produce distinct edges
    expect(result!.relationships).toContainEqual({
      srcName: 'main',
      dstName: 'promql.NewEngine',
      predicate: 'CALLS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'main',
      dstName: 'scrape.NewManager',
      predicate: 'CALLS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'main',
      dstName: 'notifier.NewManager',
      predicate: 'CALLS',
    });
  });

  it('captures chained method calls without losing them (regression: operand not identifier)', () => {
    const result = parseFile(
      '/repo/runner.go',
      `
package runner

func run(s *Service) {
  s.pool.Start()
  s.discovery.Run()
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'run',
      dstName: 'Start',
      predicate: 'CALLS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'run',
      dstName: 'Run',
      predicate: 'CALLS',
    });
  });

  it('preserves full Go import paths and captures qualified type references in function signatures', () => {
    const result = parseFile(
      '/repo/server.go',
      `
package app

import scheduler "k8s.io/kubernetes/pkg/scheduler"

func Run(sched *scheduler.Scheduler) error {
  return nil
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'server.go',
      dstName: 'k8s.io/kubernetes/pkg/scheduler',
      predicate: 'IMPORTS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Run',
      dstName: 'Scheduler',
      predicate: 'REFERENCES',
    });
  });

  it('records explicit Go import aliases so alias-qualified package calls can be resolved later', () => {
    const result = parseFile(
      '/repo/server.go',
      `
package app

import (
  controlplaneapiserver "k8s.io/kubernetes/pkg/controlplane/apiserver"
)

func CreateServerChain() {
  controlplaneapiserver.CreateAggregatorServer()
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.importAliases).toEqual({
      controlplaneapiserver: 'k8s.io/kubernetes/pkg/controlplane/apiserver',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'CreateServerChain',
      dstName: 'controlplaneapiserver.CreateAggregatorServer',
      predicate: 'CALLS',
    });
  });

  it('emits all qualified CALLS when multiple packages share a function name', () => {
    // Regression: before Bug 3 fix, only the first NewManager call was emitted
    // because seenCalls deduped bare "NewManager" across all packages.
    const result = parseFile(
      '/repo/setup.go',
      `
package main

func setup() {
  a := alpha.NewManager()
  b := beta.NewManager()
  c := gamma.NewManager()
  _, _, _ = a, b, c
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'setup',
      dstName: 'alpha.NewManager',
      predicate: 'CALLS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'setup',
      dstName: 'beta.NewManager',
      predicate: 'CALLS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'setup',
      dstName: 'gamma.NewManager',
      predicate: 'CALLS',
    });
  });
});
