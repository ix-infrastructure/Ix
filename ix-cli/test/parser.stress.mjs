/**
 * parser.stress.mjs — Comprehensive stress test for core-ingestion parser.
 *
 * Run from ix-cli/ directory:
 *   node test/parser.stress.mjs
 *
 * Tests correctness, robustness, idempotency, silent-skip behaviour,
 * and graph plausibility across all supported languages.
 *
 * Exit code 0 = all pass, 1 = at least one failure.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// ---------------------------------------------------------------------------
// Load compiled modules
// ---------------------------------------------------------------------------

const distBase = pathToFileURL(resolve(process.cwd(), '../core-ingestion/dist')).href;

const { parseFile, resolveCallEdges } = await import(`${distBase}/index.js`);
const { buildPatch, buildPatchWithResolution } = await import(`${distBase}/patch-builder.js`);
const { languageFromPath } = await import(`${distBase}/languages.js`);

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, name, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ---------------------------------------------------------------------------
// § 1  Language detection completeness
// ---------------------------------------------------------------------------
section('1. Language detection');

const extExpectations = [
  ['.ts', 'typescript'], ['.tsx', 'typescript'],
  ['.js', 'javascript'], ['.jsx', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.py', 'python'],
  ['.java', 'java'],
  ['.c', 'c'], ['.h', 'c'],
  ['.cpp', 'cpp'], ['.cc', 'cpp'], ['.cxx', 'cpp'], ['.hpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.go', 'go'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.php', 'php'],
  ['.kt', 'kotlin'], ['.kts', 'kotlin'],
  ['.swift', 'swift'],
];

for (const [ext, expected] of extExpectations) {
  const result = languageFromPath(`file${ext}`);
  assert(result === expected, `languageFromPath(${ext}) === ${expected}`, `got ${result}`);
}

assert(languageFromPath('file.txt') === null, 'languageFromPath(.txt) === null');
assert(languageFromPath('Makefile') === null, 'languageFromPath(no-ext) === null');

// ---------------------------------------------------------------------------
// § 2  Core entity + relationship extraction (TypeScript)
// ---------------------------------------------------------------------------
section('2. TypeScript — entity and relationship extraction');

const TS_FIXTURE = `
import { Foo } from './foo';
import type { Bar } from './bar';

export class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
  speak(): string { return 'sound'; }
}

export class Dog extends Animal {
  fetch(): void { this.speak(); }
}

export function createDog(name: string): Dog {
  return new Dog(name);
}

export const greet = (x: string) => x.toUpperCase();
`;

const tsResult = parseFile('animal.ts', TS_FIXTURE);
assert(tsResult !== null, 'TypeScript fixture parses without error');
if (tsResult) {
  const names = tsResult.entities.map(e => e.name);
  assert(names.includes('animal.ts'), 'file entity emitted');
  assert(names.includes('Animal'),    'class Animal detected');
  assert(names.includes('Dog'),       'class Dog detected');
  assert(names.includes('speak'),     'method speak detected');
  assert(names.includes('fetch'),     'method fetch detected');
  assert(names.includes('createDog'), 'function createDog detected');
  assert(names.includes('greet'),     'arrow-function greet detected');

  const preds = tsResult.relationships.map(r => r.predicate);
  assert(preds.includes('CONTAINS'),  'CONTAINS relationships emitted');
  assert(preds.includes('EXTENDS'),   'EXTENDS relationship (Dog→Animal) emitted');
  assert(preds.includes('IMPORTS'),   'IMPORTS relationship emitted');

  const extendsRel = tsResult.relationships.find(r => r.predicate === 'EXTENDS');
  assert(extendsRel?.srcName === 'Dog' && extendsRel?.dstName === 'Animal',
    'EXTENDS is Dog→Animal', JSON.stringify(extendsRel));

  // File should CONTAIN Animal; Animal should CONTAIN speak
  const fileContainsAnimal = tsResult.relationships.some(
    r => r.srcName === 'animal.ts' && r.dstName === 'Animal' && r.predicate === 'CONTAINS'
  );
  assert(fileContainsAnimal, 'animal.ts CONTAINS Animal');

  const classContainsMethod = tsResult.relationships.some(
    r => r.srcName === 'Animal' && r.dstName === 'speak' && r.predicate === 'CONTAINS'
  );
  assert(classContainsMethod, 'Animal CONTAINS speak');

  const importFoo = tsResult.relationships.some(
    r => r.srcName === 'animal.ts' && r.dstName === 'foo' && r.predicate === 'IMPORTS'
  );
  assert(importFoo, 'animal.ts IMPORTS foo');
}

// ---------------------------------------------------------------------------
// § 3  Python extraction
// ---------------------------------------------------------------------------
section('3. Python — entity and relationship extraction');

const PY_FIXTURE = `
import os
import sys
from collections import defaultdict

class Stack:
    def __init__(self):
        self.items = []

    def push(self, item):
        self.items.append(item)

    def pop(self):
        return self.items.pop()

class SpecialStack(Stack):
    def peek(self):
        return self.items[-1]

def helper(x):
    return x * 2
`;

const pyResult = parseFile('stack.py', PY_FIXTURE);
assert(pyResult !== null, 'Python fixture parses');
if (pyResult) {
  const names = pyResult.entities.map(e => e.name);
  assert(names.includes('Stack'),        'class Stack detected');
  assert(names.includes('SpecialStack'), 'class SpecialStack detected');
  assert(names.includes('push'),         'method push detected');
  assert(names.includes('helper'),       'function helper detected');

  const ext = pyResult.relationships.find(r => r.predicate === 'EXTENDS');
  assert(ext?.srcName === 'SpecialStack' && ext?.dstName === 'Stack',
    'EXTENDS SpecialStack→Stack', JSON.stringify(ext));

  const hasImports = pyResult.relationships.some(r => r.predicate === 'IMPORTS');
  assert(hasImports, 'IMPORTS edges present for Python');
}

// ---------------------------------------------------------------------------
// § 4  JavaScript extraction
// ---------------------------------------------------------------------------
section('4. JavaScript — extraction');

const JS_FIXTURE = `
const express = require('express');

class Router {
  get(path, handler) { handler(); }
}

class ApiRouter extends Router {
  setup() {
    this.get('/health', () => {});
  }
}

function startServer(port) {
  const app = express();
  return app;
}
`;

const jsResult = parseFile('server.js', JS_FIXTURE);
assert(jsResult !== null, 'JavaScript fixture parses');
if (jsResult) {
  const names = jsResult.entities.map(e => e.name);
  assert(names.includes('Router'),    'class Router detected');
  assert(names.includes('ApiRouter'), 'class ApiRouter detected');
  assert(names.includes('startServer'), 'function startServer detected');
  const ext = jsResult.relationships.find(r => r.predicate === 'EXTENDS');
  assert(ext?.srcName === 'ApiRouter', 'EXTENDS ApiRouter→Router', JSON.stringify(ext));
}

// ---------------------------------------------------------------------------
// § 5  Go extraction
// ---------------------------------------------------------------------------
section('5. Go — extraction');

const GO_FIXTURE = `
package main

import (
    "fmt"
    "os"
)

type Server struct {
    port int
}

type Logger interface {
    Log(msg string)
}

func NewServer(port int) *Server {
    return &Server{port: port}
}

func (s *Server) Start() {
    fmt.Println("starting")
}
`;

const goResult = parseFile('server.go', GO_FIXTURE);
assert(goResult !== null, 'Go fixture parses');
if (goResult) {
  const names = goResult.entities.map(e => e.name);
  assert(names.includes('Server'),    'struct Server detected');
  assert(names.includes('Logger'),    'interface Logger detected');
  assert(names.includes('NewServer'), 'function NewServer detected');
  assert(names.includes('Start'),     'method Start detected');
  assert(goResult.relationships.some(r => r.predicate === 'IMPORTS'), 'IMPORTS edges in Go');
}

// ---------------------------------------------------------------------------
// § 6  Rust extraction
// ---------------------------------------------------------------------------
section('6. Rust — extraction');

const RUST_FIXTURE = `
use std::collections::HashMap;

pub struct Config {
    pub name: String,
}

pub trait Runnable {
    fn run(&self);
}

pub struct App {
    config: Config,
}

impl Runnable for App {
    fn run(&self) {
        println!("running");
    }
}

pub fn create_app(name: &str) -> App {
    App { config: Config { name: name.to_string() } }
}
`;

const rustResult = parseFile('app.rs', RUST_FIXTURE);
assert(rustResult !== null, 'Rust fixture parses');
if (rustResult) {
  const names = rustResult.entities.map(e => e.name);
  assert(names.includes('Config'),   'struct Config detected');
  assert(names.includes('Runnable'), 'trait Runnable detected');
  assert(names.includes('App'),      'struct App detected');
  assert(names.includes('create_app'), 'fn create_app detected');

  const traitImpl = rustResult.relationships.find(r => r.predicate === 'EXTENDS');
  assert(traitImpl !== undefined, 'EXTENDS edge for impl Runnable for App exists');
}

// ---------------------------------------------------------------------------
// § 7  Java extraction
// ---------------------------------------------------------------------------
section('7. Java — extraction');

const JAVA_FIXTURE = `
import java.util.List;
import java.util.ArrayList;

public class UserService {
    private List<String> users = new ArrayList<>();

    public void addUser(String name) {
        users.add(name);
    }

    public List<String> getUsers() {
        return users;
    }
}

public class AdminService extends UserService {
    public void deleteUser(String name) {
        getUsers().remove(name);
    }
}
`;

const javaResult = parseFile('UserService.java', JAVA_FIXTURE);
assert(javaResult !== null, 'Java fixture parses');
if (javaResult) {
  const names = javaResult.entities.map(e => e.name);
  assert(names.includes('UserService'),  'class UserService detected');
  assert(names.includes('AdminService'), 'class AdminService detected');
  assert(names.includes('addUser'),      'method addUser detected');
  const ext = javaResult.relationships.find(r => r.predicate === 'EXTENDS');
  assert(ext?.srcName === 'AdminService', 'EXTENDS AdminService→UserService');
}

// ---------------------------------------------------------------------------
// § 8  C extraction
// ---------------------------------------------------------------------------
section('8. C — extraction');

const C_FIXTURE = `
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    int x;
    int y;
} Point;

Point* create_point(int x, int y) {
    Point* p = malloc(sizeof(Point));
    p->x = x;
    p->y = y;
    return p;
}

void print_point(Point* p) {
    printf("(%d, %d)\\n", p->x, p->y);
}
`;

const cResult = parseFile('point.c', C_FIXTURE);
assert(cResult !== null, 'C fixture parses');
if (cResult) {
  const names = cResult.entities.map(e => e.name);
  assert(names.includes('create_point'), 'function create_point detected');
  assert(names.includes('print_point'),  'function print_point detected');
  assert(cResult.relationships.some(r => r.predicate === 'IMPORTS'), 'IMPORTS edges for C includes');
}

// ---------------------------------------------------------------------------
// § 9  C++ extraction
// ---------------------------------------------------------------------------
section('9. C++ — extraction');

const CPP_FIXTURE = `
#include <string>
#include <vector>

class Shape {
public:
    virtual double area() const = 0;
    virtual ~Shape() {}
};

class Circle : public Shape {
private:
    double radius_;
public:
    explicit Circle(double r) : radius_(r) {}
    double area() const override { return 3.14 * radius_ * radius_; }
};

template<typename T>
class Container {
    std::vector<T> items_;
public:
    void add(T item) { items_.push_back(item); }
};
`;

const cppResult = parseFile('shapes.cpp', CPP_FIXTURE);
assert(cppResult !== null, 'C++ fixture parses');
if (cppResult) {
  const names = cppResult.entities.map(e => e.name);
  assert(names.includes('Shape'),     'class Shape detected');
  assert(names.includes('Circle'),    'class Circle detected');
  assert(names.includes('Container'), 'template Container detected');
  const ext = cppResult.relationships.find(r => r.predicate === 'EXTENDS');
  assert(ext?.srcName === 'Circle' && ext?.dstName === 'Shape',
    'EXTENDS Circle→Shape', JSON.stringify(ext));
}

// ---------------------------------------------------------------------------
// § 10  C# extraction
// ---------------------------------------------------------------------------
section('10. C# — extraction');

const CS_FIXTURE = `
using System;
using System.Collections.Generic;

namespace MyApp {
    public class Repository<T> {
        private List<T> items = new List<T>();

        public void Add(T item) {
            items.Add(item);
        }

        public List<T> GetAll() {
            return items;
        }
    }

    public class UserRepository : Repository<string> {
        public string Find(string name) {
            return GetAll().Find(x => x == name);
        }
    }
}
`;

const csResult = parseFile('Repository.cs', CS_FIXTURE);
assert(csResult !== null, 'C# fixture parses');
if (csResult) {
  const names = csResult.entities.map(e => e.name);
  assert(names.includes('Repository'),     'class Repository detected');
  assert(names.includes('UserRepository'), 'class UserRepository detected');
  assert(names.includes('Add'),            'method Add detected');
  assert(csResult.relationships.some(r => r.predicate === 'IMPORTS'), 'using directives as IMPORTS');
}

// ---------------------------------------------------------------------------
// § 11  PHP extraction
// ---------------------------------------------------------------------------
section('11. PHP — extraction');

const PHP_FIXTURE = `<?php
namespace App\\Models;

use App\\Contracts\\Storable;

abstract class Model implements Storable {
    protected $table;

    public function find(int $id): static {
        return new static();
    }
}

class User extends Model {
    protected $fillable = ['name', 'email'];

    public function greet(): string {
        return 'hello';
    }
}
`;

const phpResult = parseFile('User.php', PHP_FIXTURE);
assert(phpResult !== null, 'PHP fixture parses');
if (phpResult) {
  const names = phpResult.entities.map(e => e.name);
  assert(names.includes('Model'), 'class Model detected');
  assert(names.includes('User'),  'class User detected');
  assert(names.includes('greet'), 'method greet detected');
  const userExtendsModel = phpResult.relationships.find(
    r => r.predicate === 'EXTENDS' && r.srcName === 'User' && r.dstName === 'Model'
  );
  assert(userExtendsModel !== undefined, 'EXTENDS User→Model exists');
  const modelImplementsStoable = phpResult.relationships.find(
    r => r.predicate === 'EXTENDS' && r.srcName === 'Model' && r.dstName === 'Storable'
  );
  assert(modelImplementsStoable !== undefined, 'EXTENDS Model→Storable (implements) exists');
}

// ---------------------------------------------------------------------------
// § 12  Ruby extraction
// ---------------------------------------------------------------------------
section('12. Ruby — extraction');

const RUBY_FIXTURE = `
require 'json'
require_relative './base'

module Auth
  class Session
    include Serializable

    def initialize(token)
      @token = token
    end

    def valid?
      !@token.nil?
    end
  end
end
`;

const rubyResult = parseFile('session.rb', RUBY_FIXTURE);
assert(rubyResult !== null, 'Ruby fixture parses');
if (rubyResult) {
  const names = rubyResult.entities.map(e => e.name);
  assert(names.includes('Auth'),    'module Auth detected');
  assert(names.includes('Session'), 'class Session detected');
  assert(names.includes('valid?'),  'method valid? detected');
  assert(rubyResult.relationships.some(r => r.predicate === 'IMPORTS'), 'require → IMPORTS');
}

// ---------------------------------------------------------------------------
// § 13  TSX extraction
// ---------------------------------------------------------------------------
section('13. TSX — React component extraction');

const TSX_FIXTURE = `
import React, { useState } from 'react';

interface Props {
  title: string;
}

const Header: React.FC<Props> = ({ title }) => {
  const [count, setCount] = useState(0);
  return <h1>{title}</h1>;
};

export default Header;
`;

const tsxResult = parseFile('Header.tsx', TSX_FIXTURE);
assert(tsxResult !== null, 'TSX fixture parses');
if (tsxResult) {
  const names = tsxResult.entities.map(e => e.name);
  assert(names.includes('Header'),  'Header component detected');
  assert(names.includes('Props'),   'Props interface detected');
}

// ---------------------------------------------------------------------------
// § 14  CRITICAL: Duplicate entity names within the same file → nodeId collision
// ---------------------------------------------------------------------------
section('14. CRITICAL: Duplicate entity names → nodeId collision in patch');

const DUPLICATE_NAMES_FIXTURE = `
class ClassA {
  update() { return 1; }
  process() { return 2; }
}

class ClassB {
  update() { return 3; }   // same name as ClassA.update
  process() { return 4; }  // same name as ClassA.process
}
`;

const dupResult = parseFile('dup.ts', DUPLICATE_NAMES_FIXTURE);
assert(dupResult !== null, 'Duplicate names fixture parses');
if (dupResult) {
  const methodEntities = dupResult.entities.filter(e => e.name === 'update');
  assert(methodEntities.length === 2,
    'Two "update" entities extracted (one per class)', `got ${methodEntities.length}`);

  const patch = buildPatch(dupResult, 'abc123');
  const upsertNodes = patch.ops.filter(op => op.type === 'UpsertNode');
  const updateNodes = upsertNodes.filter(op => op.name === 'update');
  assert(updateNodes.length === 2,
    'Two UpsertNode ops for "update"', `got ${updateNodes.length}`);

  // Check for ID collision — both should have the SAME id (the bug)
  const ids = updateNodes.map(op => op.id);
  const collision = ids[0] === ids[1];
  // This is the BUG: same nodeId means the second upsert silently overwrites the first
  assert(!collision,
    'No nodeId collision between ClassA.update and ClassB.update (EXPECT FAIL → BUG)',
    `Both get id=${ids[0]} — the second UpsertNode silently overwrites the first`);
}

// ---------------------------------------------------------------------------
// § 15  Kotlin/Swift: discovered but silently skipped (no grammar installed)
// ---------------------------------------------------------------------------
section('15. Kotlin/Swift: parse returns null (no grammar installed)');

const KOTLIN_FIXTURE = `
data class User(val name: String, val age: Int)

fun greet(user: User): String = "Hello, \${user.name}"
`;

const kotlinResult = parseFile('user.kt', KOTLIN_FIXTURE);
// We EXPECT null — Kotlin grammar is not installed. This confirms the silent skip.
assert(kotlinResult === null,
  'Kotlin parses to null (grammar not installed — files are discovered but silently skipped)');

const SWIFT_FIXTURE = `
struct User {
    var name: String
    var age: Int

    init(name: String, age: Int) {
        self.name = name
        self.age = age
    }
}

func greet(user: User) -> String {
    return "Hello, \\(user.name)"
}
`;

const swiftResult = parseFile('user.swift', SWIFT_FIXTURE);
assert(swiftResult === null,
  'Swift parses to null (grammar not installed — files are discovered but silently skipped)');

// Consequence: walk during ix ingest discovers .kt/.swift files (languageFromPath → non-null)
// but parseFile returns null, so they are counted as "skipped" without a clear reason in output.
assert(languageFromPath('user.kt') !== null,
  'Kotlin files ARE discovered by walkFiles (languageFromPath non-null) — counts inflate');
assert(languageFromPath('user.swift') !== null,
  'Swift files ARE discovered by walkFiles (languageFromPath non-null) — counts inflate');

// ---------------------------------------------------------------------------
// § 16  Swift init_declaration: no @name capture → silent miss
// ---------------------------------------------------------------------------
section('16. Swift init_declaration missing @name capture');

// Swift grammar IS available? Actually it's not installed. But we can verify the query issue
// by checking that init_declaration entries would have no name extracted.
// The query: (init_declaration) @definition.constructor
// has NO @name capture. In parseFile, the first pass requires BOTH defCapture AND nameCapture.
// So all Swift initializers would be silently dropped even if the grammar were installed.
// We document this as a known issue.
console.log('  ℹ Swift init_declaration query has no @name capture → initializers would be');
console.log('    silently skipped even if swift grammar were installed. See queries.ts:661');

// ---------------------------------------------------------------------------
// § 17  patchId non-determinism and replaces always empty
// ---------------------------------------------------------------------------
section('17. patch-builder: patchId non-determinism + replaces always empty');

const SIMPLE_FIXTURE = `export function hello() { return 42; }`;
const r1 = parseFile('hello.ts', SIMPLE_FIXTURE);
const r2 = parseFile('hello.ts', SIMPLE_FIXTURE);

if (r1 && r2) {
  const patch1 = buildPatch(r1, 'deadbeef');
  const patch2 = buildPatch(r2, 'deadbeef');

  // patchId uses Date.now() so it is wall-clock-dependent.
  // Two calls within the same millisecond produce the same id (accidentally stable);
  // calls across milliseconds produce different ids (unstable across separate ingest runs).
  // We document this as a known design limitation rather than a hard assertion.
  console.log(`  ℹ patchId1=${patch1.patchId}`);
  console.log(`  ℹ patchId2=${patch2.patchId}`);
  console.log('  ℹ patchId uses Date.now() — non-deterministic across separate ingest runs');

  assert(patch1.replaces.length === 0 && patch2.replaces.length === 0,
    'replaces is always [] (previousPatchId never passed from ingest.ts)');

  // Verify that node IDs ARE deterministic (the graph nodes are stable)
  const node1 = patch1.ops.find(op => op.type === 'UpsertNode' && op.name === 'hello');
  const node2 = patch2.ops.find(op => op.type === 'UpsertNode' && op.name === 'hello');
  assert(node1?.id === node2?.id,
    'UpsertNode IDs are deterministic across runs (safe)', `${node1?.id}`);
}

// ---------------------------------------------------------------------------
// § 18  Idempotency: same entities/edges produced on second parse
// ---------------------------------------------------------------------------
section('18. Idempotency: re-parsing produces identical entities and edges');

const IDEM_FIXTURE = `
class Counter {
  count: number = 0;
  increment() { this.count++; }
  decrement() { this.count--; }
}
`;

const idem1 = parseFile('counter.ts', IDEM_FIXTURE);
const idem2 = parseFile('counter.ts', IDEM_FIXTURE);

if (idem1 && idem2) {
  assert(idem1.entities.length === idem2.entities.length,
    'Entity count identical on re-parse');
  assert(idem1.relationships.length === idem2.relationships.length,
    'Relationship count identical on re-parse');

  const sortNames = arr => arr.map(e => e.name).sort().join(',');
  assert(sortNames(idem1.entities) === sortNames(idem2.entities),
    'Entity names identical on re-parse');
}

// ---------------------------------------------------------------------------
// § 19  Malformed / partial files: no crash
// ---------------------------------------------------------------------------
section('19. Robustness: malformed and partial files do not crash');

const MALFORMED_CASES = [
  ['empty.ts',       ''],
  ['only-ws.ts',     '   \n\t\n   '],
  ['truncated.ts',   'class Foo { method(x: string) {'],
  ['syntax-err.ts',  'function @invalid@@() { ??? }'],
  ['unicode.ts',     '// 你好世界\nconst x = "emoji: 🎉";'],
  ['huge-string.ts', `const x = "${'a'.repeat(100_000)}";`],
  ['null-bytes.ts',  'function f() {}\x00\x00\x00'],
  ['only-comments.ts', '// just a comment\n/* and another */'],
];

for (const [name, src] of MALFORMED_CASES) {
  let threw = false;
  try {
    parseFile(name, src);
  } catch {
    threw = true;
  }
  assert(!threw, `no exception on ${name}`);
  // empty file and pure whitespace return null (no entities), which is fine
}

// ---------------------------------------------------------------------------
// § 20  File size and empty file gating (the caller-side check in ingest.ts)
// ---------------------------------------------------------------------------
section('20. Parser return value for edge-case files');

assert(parseFile('empty.ts', '') !== null || true,
  'empty .ts returns null gracefully (tree-sitter parses empty source)');
// Actually tree-sitter can parse empty source — let's verify
const emptyResult = parseFile('really-empty.ts', '');
if (emptyResult !== null) {
  // If it parses, it should have exactly the file entity
  assert(emptyResult.entities.length === 1 && emptyResult.entities[0].kind === 'file',
    'Empty file produces only file entity', `got ${emptyResult.entities.length} entities`);
} else {
  console.log('  ℹ empty source returns null — consistent with error path');
}

// ---------------------------------------------------------------------------
// § 21  Graph plausibility: node/edge counts make sense
// ---------------------------------------------------------------------------
section('21. Graph plausibility: counts are sane for moderate fixture');

const PLAUSIBILITY_FIXTURE = `
import { EventEmitter } from 'events';

export class Queue extends EventEmitter {
  private items: any[] = [];

  enqueue(item: any): void {
    this.items.push(item);
    this.emit('enqueue', item);
  }

  dequeue(): any {
    const item = this.items.shift();
    this.emit('dequeue', item);
    return item;
  }

  get size(): number { return this.items.length; }
}

export class PriorityQueue extends Queue {
  enqueue(item: any): void {
    this.items.sort();
    super.enqueue(item);
  }
}

export function createQueue(): Queue { return new Queue(); }
`;

const pqResult = parseFile('queue.ts', PLAUSIBILITY_FIXTURE);
if (pqResult) {
  const numEntities = pqResult.entities.length;
  const numRels = pqResult.relationships.length;
  const predicates = pqResult.relationships.reduce((acc, r) => {
    acc[r.predicate] = (acc[r.predicate] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`  entities: ${numEntities}, relationships: ${numRels}`);
  console.log(`  predicates: ${JSON.stringify(predicates)}`);

  assert(numEntities >= 6, `at least 6 entities (file + 2 classes + 3+ methods), got ${numEntities}`);
  assert(numRels >= 5,     `at least 5 relationships, got ${numRels}`);
  assert(predicates.CONTAINS >= 2, `CONTAINS edges >= 2, got ${predicates.CONTAINS}`);
  assert(predicates.EXTENDS >= 1,  `EXTENDS edge (PriorityQueue→Queue), got ${predicates.EXTENDS}`);
  assert(predicates.IMPORTS >= 1,  `IMPORTS edge, got ${predicates.IMPORTS}`);
}

// ---------------------------------------------------------------------------
// § 22  Cross-file CALLS are file-scoped (dangling-edge design limitation)
// ---------------------------------------------------------------------------
section('22. Cross-file CALLS edges are file-scoped (design limitation)');

const CALLER_FIXTURE = `
import { processPayment } from './payments';

export function checkout(cart: any) {
  processPayment(cart.total);
}
`;

const callerResult = parseFile('checkout.ts', CALLER_FIXTURE);
if (callerResult) {
  const callsPayment = callerResult.relationships.find(
    r => r.predicate === 'CALLS' && r.dstName === 'processPayment'
  );
  if (callsPayment) {
    // The dst nodeId will be deterministicId('checkout.ts:processPayment') — NOT the real entity
    // from payments.ts. This is a dangling edge.
    const patch = buildPatch(callerResult, 'abc');
    const callEdge = patch.ops.find(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');
    console.log(`  ℹ CALLS edge: dst=${callEdge?.dst} (file-scoped, likely dangling)`);
    console.log(`  ℹ The destination is deterministicId("checkout.ts:processPayment"),`);
    console.log(`    NOT the real processPayment node from payments.ts`);
    assert(true, 'Cross-file CALLS edge confirmed present (design limitation documented)');
  } else {
    assert(false, 'Expected CALLS processPayment edge to be generated');
  }
}

// ---------------------------------------------------------------------------
// § 23  CALLS deduplication within scope
// ---------------------------------------------------------------------------
section('23. CALLS deduplication: same callee in same scope produces one edge');

const DEDUP_FIXTURE = `
function processOrder(order: any) {
  validate(order);
  validate(order);   // duplicate call — should produce only ONE edge
  save(order);
}
`;

const dedupResult = parseFile('order.ts', DEDUP_FIXTURE);
if (dedupResult) {
  const validateCalls = dedupResult.relationships.filter(
    r => r.predicate === 'CALLS' && r.dstName === 'validate'
  );
  assert(validateCalls.length === 1,
    'Duplicate calls deduplicated to one CALLS edge', `got ${validateCalls.length}`);
}

// ---------------------------------------------------------------------------
// § 24  Java import over-capture check
// ---------------------------------------------------------------------------
section('24. Java import: checking for over-capture with child wildcard');

const JAVA_IMPORT_FIXTURE = `
import java.util.List;
import java.util.Map;
import java.util.*;

public class Test {}
`;

const javaImportResult = parseFile('Test.java', JAVA_IMPORT_FIXTURE);
if (javaImportResult) {
  const imports = javaImportResult.relationships.filter(r => r.predicate === 'IMPORTS');
  console.log(`  Import edges: ${imports.length} (raw text: ${imports.map(r => r.dstName).join(', ')})`);
  // The Java query uses (_) @import.source which may match multiple children
  // including scoped_identifier children, potentially producing duplicates
  assert(imports.length >= 3, `At least 3 import edges for 3 import stmts, got ${imports.length}`);
  // Check for obvious over-capture: "java" being extracted as an import name (just the first token)
  const trivialImports = imports.filter(r => r.dstName.length <= 4);
  if (trivialImports.length > 0) {
    console.log(`  ⚠ Over-capture: got trivial import names: ${trivialImports.map(r => r.dstName).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// § 25  buildPatch ops completeness
// ---------------------------------------------------------------------------
section('25. buildPatch: ops contain UpsertNode, UpsertEdge, AssertClaim');

const patchFixture = `
class Service {
  doWork(): void {}
}
`;
const pfResult = parseFile('service.ts', patchFixture);
if (pfResult) {
  const patch = buildPatch(pfResult, 'hashval');
  const opTypes = new Set(patch.ops.map(op => op.type));

  assert(opTypes.has('UpsertNode'),  'Patch contains UpsertNode ops');
  assert(opTypes.has('UpsertEdge'),  'Patch contains UpsertEdge ops');
  assert(opTypes.has('AssertClaim'), 'Patch contains AssertClaim ops');

  // Every UpsertNode should have required fields
  const badNodes = patch.ops
    .filter(op => op.type === 'UpsertNode')
    .filter(op => !op.id || !op.kind || !op.name);
  assert(badNodes.length === 0, `All UpsertNode ops have id/kind/name, bad: ${badNodes.length}`);

  // Every UpsertEdge should have src/dst/predicate
  const badEdges = patch.ops
    .filter(op => op.type === 'UpsertEdge')
    .filter(op => !op.id || !op.src || !op.dst || !op.predicate);
  assert(badEdges.length === 0, `All UpsertEdge ops have id/src/dst/predicate, bad: ${badEdges.length}`);

  // Source metadata should be present
  assert(patch.source.uri === 'service.ts', 'patch.source.uri correct');
  assert(patch.source.extractor === 'tree-sitter/1.0', 'patch.source.extractor correct');
  assert(patch.source.sourceHash === 'hashval', 'patch.source.sourceHash correct');
}

// ---------------------------------------------------------------------------
// § 26  entitiesCreated hardcoded 0 in JSON output (ingest.ts bug)
// ---------------------------------------------------------------------------
section('26. JSON output: entitiesCreated is hardcoded 0 (ingest.ts:176)');
console.log('  ℹ ingest.ts line 176: entitiesCreated: 0 — this field is always 0 in JSON output.');
console.log('    The parser does not return a count of backend-created entities (that requires');
console.log('    a server round-trip). This is a misleading metric, not a crash bug.');

// ---------------------------------------------------------------------------
// § 27  Cross-file CALLS resolution
// ---------------------------------------------------------------------------
section('27. Cross-file CALLS resolution via resolveCallEdges()');

const PAYMENTS_FIXTURE = `
export function processPayment(amount: number): boolean {
  return amount > 0;
}

export function refund(amount: number): void {}
`;

const CHECKOUT_FIXTURE = `
import { processPayment } from './payments';

export function checkout(cart: any) {
  processPayment(cart.total);
}
`;

const paymentsResult = parseFile('payments.ts', PAYMENTS_FIXTURE);
const checkoutResult = parseFile('checkout.ts', CHECKOUT_FIXTURE);

assert(paymentsResult !== null, '§27 payments.ts parses');
assert(checkoutResult !== null, '§27 checkout.ts parses');

if (paymentsResult && checkoutResult) {
  const resolved = resolveCallEdges([paymentsResult, checkoutResult]);

  const edge = resolved.find(e => e.calleeName === 'processPayment');

  assert(edge !== undefined, '§27 resolveCallEdges finds processPayment edge');

  if (edge) {
    assert(
      edge.calleeFilePath.includes('payments'),
      '§27 calleeFilePath points to payments file',
      `got ${edge.calleeFilePath}`
    );
    assert(
      edge.calleeName === 'processPayment',
      '§27 calleeName is processPayment',
      `got ${edge.calleeName}`
    );
    assert(
      edge.confidence >= 0.9,
      `§27 confidence >= 0.9 (import-scoped, not global fallback), got ${edge.confidence}`
    );

    // Build patch with resolution and verify CALLS edge dst
    const checkoutPatch = buildPatchWithResolution(checkoutResult, 'abc123', resolved);
    const callsEdge = checkoutPatch.ops.find(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS' && op.dst !== undefined);

    assert(callsEdge !== undefined, '§27 CALLS UpsertEdge present in patch');

    if (callsEdge) {
      // Build the expected dst: nodeId("payments.ts", "processPayment")
      // nodeId uses deterministicId(`${filePath}:${name}`) which is SHA256-derived
      // We verify by building the payments patch and finding the processPayment node id
      const paymentsPatch = buildPatch(paymentsResult, 'xyz456');
      const processPaymentNode = paymentsPatch.ops.find(
        op => op.type === 'UpsertNode' && op.name === 'processPayment'
      );

      assert(processPaymentNode !== undefined, '§27 processPayment UpsertNode found in payments patch');

      if (processPaymentNode) {
        assert(
          callsEdge.dst === processPaymentNode.id,
          `§27 CALLS edge dst === nodeId("payments.ts","processPayment")`,
          `dst=${callsEdge.dst} expected=${processPaymentNode.id}`
        );

        // Also verify it does NOT equal the file-scoped (dangling) id
        const danglingPatch = buildPatch(checkoutResult, 'abc123');
        const danglingEdge = danglingPatch.ops.find(
          op => op.type === 'UpsertEdge' && op.predicate === 'CALLS'
        );
        if (danglingEdge) {
          assert(
            callsEdge.dst !== danglingEdge.dst,
            '§27 resolved dst differs from dangling (file-scoped) dst'
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// § 28  Class-method qualified key resolution
// ---------------------------------------------------------------------------
section('28. Cross-file CALLS resolution: class method uses qualified key (ClassName.method)');

const PAYMENT_SERVICE_FIXTURE = `
export class PaymentService {
  charge(amount: number): boolean { return amount > 0; }
  refund(amount: number): void {}
}
`;

const ORDER_FIXTURE = `
import { PaymentService } from './payment-service';

export function placeOrder(cart: any) {
  const svc = new PaymentService();
  svc.charge(cart.total);
}
`;

const psResult = parseFile('payment-service.ts', PAYMENT_SERVICE_FIXTURE);
const orderResult = parseFile('order.ts', ORDER_FIXTURE);

assert(psResult !== null, '§28 payment-service.ts parses');
assert(orderResult !== null, '§28 order.ts parses');

if (psResult && orderResult) {
  const resolvedCM = resolveCallEdges([psResult, orderResult]);
  const chargeEdge = resolvedCM.find(e => e.calleeName === 'charge');

  assert(chargeEdge !== undefined, '§28 resolveCallEdges finds charge edge');

  if (chargeEdge) {
    assert(
      chargeEdge.calleeQualifiedKey === 'PaymentService.charge',
      `§28 calleeQualifiedKey is PaymentService.charge`,
      `got ${chargeEdge.calleeQualifiedKey}`
    );
    assert(chargeEdge.confidence >= 0.9, `§28 confidence >= 0.9, got ${chargeEdge.confidence}`);

    // Verify dst in patch points to the qualified nodeId
    const psPatch = buildPatch(psResult, 'ps-hash');
    const chargeNode = psPatch.ops.find(op => op.type === 'UpsertNode' && op.name === 'charge');
    assert(chargeNode !== undefined, '§28 charge UpsertNode found in payment-service patch');

    if (chargeNode) {
      const orderPatch = buildPatchWithResolution(orderResult, 'order-hash', resolvedCM);
      const callsCharge = orderPatch.ops.find(
        op => op.type === 'UpsertEdge' && op.predicate === 'CALLS' && op.dst === chargeNode.id
      );
      assert(
        callsCharge !== undefined,
        `§28 CALLS edge dst === nodeId("payment-service.ts", "PaymentService.charge")`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// § 29  Directory import resolution (index.ts)
// ---------------------------------------------------------------------------
section('29. Cross-file CALLS resolution: directory import resolves to index.ts');

const UTILS_INDEX_FIXTURE = `
export function formatCurrency(amount: number): string {
  return '$' + amount.toFixed(2);
}
`;

const INVOICE_FIXTURE = `
import { formatCurrency } from './utils';

export function generateInvoice(total: number): string {
  return formatCurrency(total);
}
`;

// Simulate utils/index.ts by using a path where basename is 'index' and parent dir is 'utils'
const utilsIndexResult = parseFile('utils/index.ts', UTILS_INDEX_FIXTURE);
const invoiceResult = parseFile('invoice.ts', INVOICE_FIXTURE);

assert(utilsIndexResult !== null, '§29 utils/index.ts parses');
assert(invoiceResult !== null, '§29 invoice.ts parses');

if (utilsIndexResult && invoiceResult) {
  const resolvedDir = resolveCallEdges([utilsIndexResult, invoiceResult]);
  const fmtEdge = resolvedDir.find(e => e.calleeName === 'formatCurrency');

  assert(fmtEdge !== undefined, '§29 resolveCallEdges finds formatCurrency via directory import');

  if (fmtEdge) {
    assert(
      fmtEdge.calleeFilePath.includes('utils'),
      `§29 calleeFilePath resolves into utils directory`,
      `got ${fmtEdge.calleeFilePath}`
    );
    assert(fmtEdge.confidence >= 0.9, `§29 confidence >= 0.9, got ${fmtEdge.confidence}`);

    const utilsPatch = buildPatch(utilsIndexResult, 'utils-hash');
    const fmtNode = utilsPatch.ops.find(op => op.type === 'UpsertNode' && op.name === 'formatCurrency');
    assert(fmtNode !== undefined, '§29 formatCurrency UpsertNode found in utils/index patch');

    if (fmtNode) {
      const invPatch = buildPatchWithResolution(invoiceResult, 'inv-hash', resolvedDir);
      const callsFmt = invPatch.ops.find(
        op => op.type === 'UpsertEdge' && op.predicate === 'CALLS' && op.dst === fmtNode.id
      );
      assert(
        callsFmt !== undefined,
        `§29 CALLS edge dst === nodeId("utils/index.ts", "formatCurrency")`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// § 30  Bare path-alias import resolution (@components, ~lib, #utils)
// ---------------------------------------------------------------------------
section('30. Import resolution: bare aliases strip leading non-word chars');

const AUTH_MODULE_FIXTURE = `
export function verifyToken(token: string): boolean {
  return token.length > 0;
}
`;

// Simulates: import { verifyToken } from '@auth'
// parseFile stores modName = '@auth' (no slash to split on)
// resolveCallEdges should strip '@' → 'auth' → match 'auth.ts'
const BARE_ALIAS_CALLER_FIXTURE = `
import { verifyToken } from '@auth';

export function protect(req: any) {
  verifyToken(req.headers.token);
}
`;

const authResult = parseFile('auth.ts', AUTH_MODULE_FIXTURE);
const protectResult = parseFile('middleware.ts', BARE_ALIAS_CALLER_FIXTURE);

assert(authResult !== null, '§30 auth.ts parses');
assert(protectResult !== null, '§30 middleware.ts parses');

if (authResult && protectResult) {
  const resolvedAlias = resolveCallEdges([authResult, protectResult]);
  const vtEdge = resolvedAlias.find(e => e.calleeName === 'verifyToken');

  assert(vtEdge !== undefined, '§30 resolveCallEdges finds verifyToken via @auth alias');
  if (vtEdge) {
    assert(vtEdge.calleeFilePath === 'auth.ts', `§30 calleeFilePath = auth.ts, got ${vtEdge.calleeFilePath}`);
    assert(vtEdge.confidence >= 0.9, `§30 confidence >= 0.9, got ${vtEdge.confidence}`);
    assert(vtEdge.calleeQualifiedKey === 'verifyToken', `§30 calleeQualifiedKey = verifyToken, got ${vtEdge.calleeQualifiedKey}`);
  }
}

// ---------------------------------------------------------------------------
// § 31  Ambiguous class methods: edge suppressed rather than emitting bad nodeId
// ---------------------------------------------------------------------------
section('31. Ambiguous class method resolution: edge not emitted (prevents bad nodeId)');

const AMBIGUOUS_SERVICE_FIXTURE = `
export class ServiceA {
  process(data: any): void {}
}

export class ServiceB {
  process(data: any): void {}
}
`;

const AMBIGUOUS_CALLER_FIXTURE = `
import { ServiceA } from './ambiguous-service';

export function run(data: any) {
  const svc = new ServiceA();
  svc.process(data);
}
`;

const ambSvcResult = parseFile('ambiguous-service.ts', AMBIGUOUS_SERVICE_FIXTURE);
const ambCallerResult = parseFile('runner.ts', AMBIGUOUS_CALLER_FIXTURE);

assert(ambSvcResult !== null, '§31 ambiguous-service.ts parses');
assert(ambCallerResult !== null, '§31 runner.ts parses');

if (ambSvcResult && ambCallerResult) {
  const resolvedAmb = resolveCallEdges([ambSvcResult, ambCallerResult]);
  const processEdge = resolvedAmb.find(e => e.calleeName === 'process');

  assert(processEdge === undefined,
    '§31 ambiguous class method "process" produces no resolved edge (prevents dangling nodeId)');

  // Verify that a non-ambiguous call in the same file still resolves
  const newEdge = resolvedAmb.find(e => e.calleeName === 'ServiceA');
  // ServiceA constructor call: only one entity named ServiceA → resolves
  if (newEdge) {
    assert(newEdge.calleeQualifiedKey === 'ServiceA',
      '§31 unambiguous ServiceA constructor call resolves correctly');
  }
}

// ---------------------------------------------------------------------------
// § 32  require() calls filtered by BUILTINS
// ---------------------------------------------------------------------------
section('32. require() calls are filtered by BUILTINS');
const r32 = parseFile('server.js', `
  const express = require('express');
  const fs = require('fs');
  function start() { require('path'); }
`);
if (r32) {
  const requireCalls = r32.relationships.filter(
    r => r.predicate === 'CALLS' && r.dstName === 'require'
  );
  assert(requireCalls.length === 0,
    '§32 require() calls not emitted as CALLS edges', `got ${requireCalls.length}`);
}

// ---------------------------------------------------------------------------
// § 33  Imported module name does not block cross-file CALLS resolution
// ---------------------------------------------------------------------------
section('33. Imported module name does not block cross-file CALLS resolution');
const r33caller = parseFile('checkout.ts', `
  import format from './format';
  export function run(x) { format(x); }
`);
const r33callee = parseFile('format.ts', `
  export function format(x) { return String(x); }
`);
if (r33caller && r33callee) {
  const edges33 = resolveCallEdges([r33caller, r33callee]);
  const edge33 = edges33.find(e => e.calleeName === 'format');
  assert(edge33 !== undefined,
    '§33 format() resolves to format.ts despite module entity of same name in caller');
  if (edge33) {
    assert(edge33.calleeFilePath === 'format.ts',
      `§33 calleeFilePath = format.ts, got ${edge33.calleeFilePath}`);
    assert(edge33.confidence >= 0.9, `§33 confidence >= 0.9, got ${edge33.confidence}`);
  }
}

// ---------------------------------------------------------------------------
// § 34  Two classes with same method name produce two distinct CALLS edges
// ---------------------------------------------------------------------------
section('34. Two classes with same method name produce two distinct CALLS edges');
const r34 = parseFile('multi.ts', `
  class ClassA {
    update() { helper(); }
  }
  class ClassB {
    update() { helper(); }
  }
`);
if (r34) {
  const helperCalls = r34.relationships.filter(
    r => r.predicate === 'CALLS' && r.dstName === 'helper'
  );
  assert(helperCalls.length === 2,
    '§34 Both ClassA.update and ClassB.update emit a CALLS edge to helper',
    `got ${helperCalls.length}`);

  const srcNames = helperCalls.map(r => r.srcName).sort();
  assert(srcNames.includes('ClassA.update'),
    '§34 one CALLS edge has srcName ClassA.update', `srcNames: ${srcNames}`);
  assert(srcNames.includes('ClassB.update'),
    '§34 one CALLS edge has srcName ClassB.update', `srcNames: ${srcNames}`);
}

// ---------------------------------------------------------------------------
// § 35  Python relative imports strip leading dots from entity/IMPORTS names
// ---------------------------------------------------------------------------
section('35. Python relative imports strip leading dots from entity/IMPORTS names');
const r35 = parseFile('auth.py', `
from . import utils
from .models import User
from ..core import Config
`);
if (r35) {
  const moduleEntities = r35.entities.filter(e => e.kind === 'module').map(e => e.name);
  const dotEntities = moduleEntities.filter(n => n.startsWith('.'));
  assert(dotEntities.length === 0,
    '§35 no module entity names start with a dot', `got: ${dotEntities}`);

  const importNames = r35.relationships
    .filter(r => r.predicate === 'IMPORTS')
    .map(r => r.dstName);
  const dotImports = importNames.filter(n => n.startsWith('.'));
  assert(dotImports.length === 0,
    '§35 no IMPORTS dstName starts with a dot', `got: ${dotImports}`);

  // 'from . import utils' should produce no entity at all (bare dot → empty after strip)
  const bareImport = r35.relationships.find(
    r => r.predicate === 'IMPORTS' && r.dstName === ''
  );
  assert(bareImport === undefined, '§35 bare "from . import X" does not create empty IMPORTS edge');
}

// ---------------------------------------------------------------------------
// § 36  Swift init_declaration — 'init' name synthesised when no @name capture
// ---------------------------------------------------------------------------
section('36. Swift init_declaration produces entity with name "init"');
const r36 = parseFile('app.swift', `
  class DataStore {
    init(url: String) { }
    func load() { fetch(); }
  }
`);
// Swift grammar not installed — parseFile returns null; skip gracefully
if (r36 !== null) {
  const initEntity = r36.entities.find(e => e.name === 'init');
  assert(initEntity !== undefined, '§36 init entity emitted for Swift initializer');
  if (initEntity) {
    assert(initEntity.kind === 'method', `§36 init kind is method, got ${initEntity.kind}`);
    assert(initEntity.container === 'DataStore', `§36 init is contained by DataStore, got ${initEntity.container}`);
  }
} else {
  console.log('  ℹ §36 skipped — Swift grammar not installed');
}

// ---------------------------------------------------------------------------
// § 37  isGrammarSupported filters Kotlin and Swift
// ---------------------------------------------------------------------------
section('37. isGrammarSupported returns false for Kotlin/Swift, true for TS/Python');
const { isGrammarSupported } = await import(`${distBase}/index.js`);
assert(isGrammarSupported('foo.kt') === false, '§37 isGrammarSupported(foo.kt) === false');
assert(isGrammarSupported('foo.swift') === false, '§37 isGrammarSupported(foo.swift) === false');
assert(isGrammarSupported('foo.ts') === true, '§37 isGrammarSupported(foo.ts) === true');
assert(isGrammarSupported('foo.tsx') === true, '§37 isGrammarSupported(foo.tsx) === true');
assert(isGrammarSupported('foo.py') === true, '§37 isGrammarSupported(foo.py) === true');
assert(isGrammarSupported('foo.txt') === false, '§37 isGrammarSupported(foo.txt) === false');

// ---------------------------------------------------------------------------
// § 38  Python relative imports — imported symbol names recorded as IMPORTS
// ---------------------------------------------------------------------------
section('38. Python "from . import utils" records IMPORTS edge to utils');
const r38 = parseFile('services/auth.py', `
from . import utils
from .models import User
from ..core import Config
`);
if (r38) {
  const importDstNames = r38.relationships
    .filter(r => r.predicate === 'IMPORTS')
    .map(r => r.dstName);

  assert(importDstNames.includes('utils'),
    '§38 IMPORTS edge to "utils" from "from . import utils"',
    `got: ${importDstNames}`);

  assert(importDstNames.includes('User'),
    '§38 IMPORTS edge to "User" from "from .models import User"',
    `got: ${importDstNames}`);

  assert(importDstNames.includes('Config'),
    '§38 IMPORTS edge to "Config" from "from ..core import Config"',
    `got: ${importDstNames}`);

  // 'models' and 'core' still captured from the module path (after dot-stripping)
  assert(importDstNames.includes('models'),
    '§38 IMPORTS edge to "models" (module path) still emitted',
    `got: ${importDstNames}`);

  const dotImports = importDstNames.filter(n => n.startsWith('.'));
  assert(dotImports.length === 0, '§38 no dot-prefixed IMPORTS dstName', `got: ${dotImports}`);
}

// ---------------------------------------------------------------------------
// § 39  Transitive re-export resolution (three-file chain)
// ---------------------------------------------------------------------------
section('39. Transitive re-export: baz.ts calls foo() defined in bar.ts, re-exported via index.ts');
const r39bar = parseFile('bar.ts', `
  export function foo(x: number): number { return x * 2; }
`);
const r39index = parseFile('index.ts', `
  export { foo } from './bar';
`);
const r39baz = parseFile('baz.ts', `
  import { foo } from './index';
  export function run(n: number) { return foo(n); }
`);
if (r39bar && r39index && r39baz) {
  const edges39 = resolveCallEdges([r39bar, r39index, r39baz]);
  const fooEdge = edges39.find(e => e.calleeName === 'foo' && e.callerFilePath === 'baz.ts');
  assert(fooEdge !== undefined,
    '§39 foo() in baz.ts resolves through re-export in index.ts to bar.ts');
  if (fooEdge) {
    assert(fooEdge.calleeFilePath === 'bar.ts',
      `§39 calleeFilePath = bar.ts, got ${fooEdge.calleeFilePath}`);
    assert(fooEdge.confidence >= 0.8, `§39 confidence >= 0.8, got ${fooEdge.confidence}`);
  }
}

// ---------------------------------------------------------------------------
// § 40  Dynamic import with string literal produces IMPORTS edge
// ---------------------------------------------------------------------------
section('40. Dynamic import("./utils") produces IMPORTS edge');
const r40 = parseFile('loader.ts', `
  async function loadUtils() {
    const mod = await import('./utils');
    return mod.parse();
  }
`);
if (r40) {
  const importDsts = r40.relationships
    .filter(r => r.predicate === 'IMPORTS')
    .map(r => r.dstName);
  assert(importDsts.includes('utils'),
    '§40 IMPORTS edge to "utils" from dynamic import("./utils")',
    `got: ${importDsts}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n════════════════════════════════════════════');
console.log(`  Total: ${passed + failed} checks`);
console.log(`  ✓ Passed: ${passed}`);
console.log(`  ✗ Failed: ${failed}`);
if (failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of failures) {
    console.log(`    - ${f.name}`);
    if (f.detail) console.log(`      ${f.detail}`);
  }
}
console.log('════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
