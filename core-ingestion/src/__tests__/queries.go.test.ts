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
      importRaw: 'fmt',
    });
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
      importRaw: 'k8s.io/kubernetes/pkg/scheduler',
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

  it('package-prefixes bare-function CALL dstNames so same-named functions in different packages resolve to disjoint symbols', () => {
    // Two files, two packages, both defining a bare function `addKnownTypes`
    // and a caller (`init()`) that invokes it. Without package prefixing,
    // both CALLs collapse onto the same bare name in the symbol table and
    // resolution becomes non-deterministic (last-write-wins). With prefixing,
    // each CALL points at a distinct package-qualified target.
    const fooResult = parseFile(
      '/repo/foo/register.go',
      `
package foo

var SchemeBuilder = something{}

func addKnownTypes(s *Scheme) error { return nil }

func init() { addKnownTypes(nil) }
      `,
    );
    const barResult = parseFile(
      '/repo/bar/register.go',
      `
package bar

func addKnownTypes(s *Scheme) error { return nil }

func init() { addKnownTypes(nil) }
      `,
    );

    expect(fooResult).not.toBeNull();
    expect(barResult).not.toBeNull();

    // Each init() bare-name CALL should be package-qualified.
    expect(fooResult!.relationships).toContainEqual({
      srcName: 'init',
      dstName: 'foo.addKnownTypes',
      predicate: 'CALLS',
    });
    expect(barResult!.relationships).toContainEqual({
      srcName: 'init',
      dstName: 'bar.addKnownTypes',
      predicate: 'CALLS',
    });

    // Each entity should carry its package as packageScope so the parse-worker
    // can compose the symbol-table key as `pkg.name`.
    for (const e of fooResult!.entities) {
      if (e.kind === 'function') expect(e.packageScope).toBe('foo');
    }
    for (const e of barResult!.entities) {
      if (e.kind === 'function') expect(e.packageScope).toBe('bar');
    }
  });

  it('resolves method-call qualifier to parameter type so opts.Run becomes Options.Run', () => {
    const result = parseFile(
      '/repo/svc.go',
      `
package svc

type Options struct{}
func (o *Options) Run()    {}

type Scheme struct{}
func (s *Scheme) Register() {}

// Parameter type substitution
func handle(opts *Options) {
  opts.Run()
}

// Receiver type substitution
func (s *Scheme) start(opts *Options) {
  s.Register()
  opts.Run()
}
      `,
    );

    expect(result).not.toBeNull();
    const rels = result!.relationships;

    // Parameter substitution: opts is typed *Options, so opts.Run → Options.Run
    expect(rels).toContainEqual({
      srcName: 'handle',
      dstName: 'Options.Run',
      predicate: 'CALLS',
    });

    // Receiver substitution: s is typed *Scheme, so s.Register → Scheme.Register.
    // Caller srcName for a method is the container-qualified form ("Scheme.start").
    expect(rels).toContainEqual({
      srcName: 'Scheme.start',
      dstName: 'Scheme.Register',
      predicate: 'CALLS',
    });

    // Other param within the same method still resolves
    expect(rels).toContainEqual({
      srcName: 'Scheme.start',
      dstName: 'Options.Run',
      predicate: 'CALLS',
    });
  });

  it('captures REFERENCES from type assertions, type switches, var declarations, and qualified composite literals', () => {
    const result = parseFile(
      '/repo/refs.go',
      `
package refs

import "io"

type Closer interface { Close() error }

func use(x any) {
  // Type assertion
  if c, ok := x.(Closer); ok { _ = c }
  // Type switch
  switch v := x.(type) {
    case Closer: _ = v
    case *Buffer: _ = v
    case io.Reader: _ = v
  }
}

// Var declarations
var globalBuf Buffer
var globalReader io.Reader
var globalSlice []Item

func init() {
  // Composite literal with qualified type
  _ = &io.LimitedReader{R: nil}
}
      `,
    );

    expect(result).not.toBeNull();
    const rels = result!.relationships;

    // Type assertion REFERENCES
    expect(rels).toContainEqual({ srcName: 'use', dstName: 'Closer', predicate: 'REFERENCES' });

    // Type switch case REFERENCES
    expect(rels).toContainEqual({ srcName: 'use', dstName: 'Buffer', predicate: 'REFERENCES' });
    expect(rels).toContainEqual({ srcName: 'use', dstName: 'Reader', predicate: 'REFERENCES' });

    // Var-declaration REFERENCES (caller resolves to file since they're file-scope)
    const refsTo = (name: string) => rels.filter(r => r.predicate === 'REFERENCES' && r.dstName === name);
    expect(refsTo('Buffer').length).toBeGreaterThanOrEqual(1);
    expect(refsTo('Reader').length).toBeGreaterThanOrEqual(1);
    expect(refsTo('Item').length).toBeGreaterThanOrEqual(1);

    // Composite literal with qualified type
    expect(refsTo('LimitedReader').length).toBeGreaterThanOrEqual(1);
  });

  it('captures CALLS where the receiver operand is not an identifier or selector chain', () => {
    // Real-world Go uses many receiver shapes that aren't bare identifiers or
    // dotted chains. Each block below produces a method call whose function:
    // selector_expression has a non-(identifier|selector_expression) operand.
    const result = parseFile(
      '/repo/shapes.go',
      `
package shapes

type Item struct{}
func (it *Item) Run()  {}
func (it *Item) Step() {}

type Fooer interface { Foo() }

func factory() *Item { return nil }

func callsViaCall()          { factory().Run() }
func callsViaIndex(xs []*Item) { xs[0].Run() }
func callsViaSlice(xs []*Item) { xs[1:][0].Run() }
func callsViaTypeAssert(x any) { x.(Fooer).Foo() }
func callsViaParens(it *Item)  { (it).Run() }
func callsViaDeref(p **Item)   { (*p).Run() }
      `,
    );

    expect(result).not.toBeNull();
    for (const caller of [
      'callsViaCall',
      'callsViaIndex',
      'callsViaSlice',
      'callsViaTypeAssert',
      'callsViaParens',
      'callsViaDeref',
    ]) {
      const dst = caller === 'callsViaTypeAssert' ? 'Foo' : 'Run';
      expect(result!.relationships).toContainEqual({
        srcName: caller,
        dstName: dst,
        predicate: 'CALLS',
      });
    }
  });
});
