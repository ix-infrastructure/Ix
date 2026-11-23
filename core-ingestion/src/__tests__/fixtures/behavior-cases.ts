// Copyright 2026 Ix Infrastructure Inc.

// Each label identifies an actual source slice. The oracle is independent of
// tree-sitter, parser traversal order, graph IDs and extractor fingerprints.
export type GuardLabel = [expression: string, arm: 'then' | 'else', sameSlot: boolean | null];
export interface SiteLabel {
  owner: string;
  assignment: string;
  to: string;
  guards: GuardLabel[];
  prior?: string;
}
export interface BehaviorCase { name: string; source: string; sites: SiteLabel[] }

const queued = 'this.status === "queued"';
const phase = '"idle" === (this.phase)';
const ready: GuardLabel = ['ready', 'then', false];

export const positiveCases: BehaviorCase[] = [
  {
    name: 'lexical arms and writes sharing an instance field',
    source: `class Job {
  start() {
    if (this.status === "queued") {
      this.status = "running";
      this.status = "busy";
    } else if (ready) this.status = "resume";
    else this.status = "waiting";
  }
  stop() { this.status = "done"; }
}`,
    sites: [
      { owner: 'Job.start', assignment: 'this.status = "running"', to: 'running', guards: [[queued, 'then', true]], prior: 'queued' },
      { owner: 'Job.start', assignment: 'this.status = "busy"', to: 'busy', guards: [[queued, 'then', true]] },
      { owner: 'Job.start', assignment: 'this.status = "resume"', to: 'resume', guards: [[queued, 'else', true], ready] },
      { owner: 'Job.start', assignment: 'this.status = "waiting"', to: 'waiting', guards: [[queued, 'else', true], ['ready', 'else', false]] },
      { owner: 'Job.stop', assignment: 'this.status = "done"', to: 'done', guards: [] },
    ],
  },
  {
    name: 'nested guards, calls and awaits',
    source: `class Task {
  async run() {
    if (ready) {
      if ("idle" === (this.phase)) { /* first */ { this.phase = "go"; } }
    }
    if (this.phase === "go") { touch(); this.phase = "after call"; }
    if (this.phase === "after call") { await tick(); this.phase = "after await"; }
    if (this.phase === "ready") { if (probe()) this.phase = "probed"; }
  }
}`,
    sites: [
      { owner: 'Task.run', assignment: 'this.phase = "go"', to: 'go', guards: [ready, [phase, 'then', true]], prior: 'idle' },
      { owner: 'Task.run', assignment: 'this.phase = "after call"', to: 'after call', guards: [['this.phase === "go"', 'then', true]] },
      { owner: 'Task.run', assignment: 'this.phase = "after await"', to: 'after await', guards: [['this.phase === "after call"', 'then', true]] },
      { owner: 'Task.run', assignment: 'this.phase = "probed"', to: 'probed', guards: [['this.phase === "ready"', 'then', true], ['probe()', 'then', null]] },
    ],
  },
  {
    name: 'unrelated, loose and opaque predicates',
    source: `class Task {
  check() {
    if (other.status === "idle") this.status = "a";
    if (this.phase === "a") this.status = "b";
    if (this.status == "b") this.status = "c";
    if (this.status !== "c") this.status = "d";
    if (ready && this.status === "d") this.status = "e";
    if (!ok) return; this.status = "f";
  }
}`,
    sites: [
      { owner: 'Task.check', assignment: 'this.status = "a"', to: 'a', guards: [['other.status === "idle"', 'then', false]] },
      { owner: 'Task.check', assignment: 'this.status = "b"', to: 'b', guards: [['this.phase === "a"', 'then', false]] },
      { owner: 'Task.check', assignment: 'this.status = "c"', to: 'c', guards: [['this.status == "b"', 'then', true]] },
      { owner: 'Task.check', assignment: 'this.status = "d"', to: 'd', guards: [['this.status !== "c"', 'then', true]] },
      { owner: 'Task.check', assignment: 'this.status = "e"', to: 'e', guards: [['ready && this.status === "d"', 'then', null]] },
      { owner: 'Task.check', assignment: 'this.status = "f"', to: 'f', guards: [] },
    ],
  },
  {
    name: 'independent named local bindings',
    source: `export const pump = () => {
  let state = 'cold';
  if (state === 'cold') state = 'warm';
};
function finish() {
  let phase;
  if (authorized) phase = 'done';
}`,
    sites: [
      { owner: 'pump', assignment: "state = 'warm'", to: 'warm', guards: [["state === 'cold'", 'then', true]], prior: 'cold' },
      { owner: 'finish', assignment: "phase = 'done'", to: 'done', guards: [['authorized', 'then', false]] },
    ],
  },
];

const method = (body: string) => 'class A { go() { ' + body + ' } }';
const fn = (body: string) => 'function run() { ' + body + ' }';

// One separately labeled rejection case per row, including deliberate omissions
// of real state changes that require a broader analysis.
// These Step 7 exclusions become positive examples starting with producer 1.33.
export const formerFlowExclusions = [
  method('while (ready) this.status = "x"'), method('try { this.status = "x" } finally {}'),
];

export const negativeCases: [name: string, source: string, typescriptOnly?: boolean][] = [
  ['unrelated receiver', method('other.status = "x"')],
  ['alias of this', method('const self = this; self.state = "x"')],
  ['non-state field', method('this.name = "x"')],
  ['computed field', method('this["status"] = "x"')],
  ['nested member', method('this.job.status = "x"')],
  ['dynamic value', method('this.phase = nextPhase()')],
  ['template value', method('this.status = `idle`')],
  ['compound assignment', method('this.state += "x"')],
  ['inside switch', method('switch (v) { case 1: this.status = "x"; }')],
  ['labeled block', method('retry: { this.state = "x"; }')],
  ['conditional expression', method('ok ? this.status = "x" : noop()')],
  ['short circuit', method('ok && (this.status = "x")')],
  ['chained write', method('v = this.status = "x"')],
  ['callback captures this', method('later(() => { this.status = "x" })')],
  ['static method', 'class A { static go() { this.status = "x" } }'],
  ['field initializer arrow', 'class A { go = () => { this.status = "x" } }'],
  ['accessor body', 'class A { get next() { this.status = "x"; return 1 } }'],
  ['object method', 'const object = { go() { this.status = "x" } }'],
  ['receiver in free function', fn('this.state = "x"')],
  ['outer binding', 'let status; function run() { status = "x" }'],
  ['parameter binding', 'function run(state) { state = "x" }'],
  ['destructured parameter', 'function run({state}) { state = "x" }'],
  ['var binding', fn('var phase; phase = "x"')],
  ['const binding', fn('const state = "x"')],
  ['later declaration', fn('state = "x"; let state')],
  ['shadowed in block', fn('let state; { let state; state = "x" }')],
  ['destructured shadow', fn('let phase; { let {p: phase} = value; phase = "x" }')],
  ['escaped shadow', fn(String.raw`let state; { let \u0073tate; state = "x" }`)],
  ['loop binding', fn('let state; for (let state of xs) {} state = "x"')],
  ['catch binding', fn('let status; try {} catch (status) {} status = "x"')],
  ['captured outer let', fn('let state; function later() { state = "x" }')],
  ['nested class', fn('class B { go() { this.status = "x" } }')],
  ['ambiguous function', 'function run(){let state; state="x"}\nfunction run(){}'],
  ['ambiguous class', 'class A { go(){this.status="x"} }\nclass A {}'],
  ['ambiguous method', 'class A { go(){this.status="x"} go(){} }'],
  ['same-line wrong container', 'class A {} class B { run(){this.status="x"} }'],
  ['symbol key collides with a type', 'type run = string;\nfunction run(){let phase; phase="x"}', true],
  ['returned boolean closure', fn('let open = false; return { start(){ open = true } }')],
];
