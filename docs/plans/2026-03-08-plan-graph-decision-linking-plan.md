# Plan Graph + Decision Linking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Ix from low-level graph primitives into a planning and reasoning layer — add plan graph, decision linking, remove MCP, fix CLI output.

**Architecture:** All new features are client-side via GraphPatch submissions to `POST /v1/patch`. Two new NodeKinds (Plan, Task) added to the backend. CLI output split: stderr for human diagnostics, stdout for primary output. MCP deleted entirely.

**Tech Stack:** TypeScript (CLI), Scala (backend NodeKind only), Commander, vitest

---

### Task 1: Remove MCP completely

**Files:**
- Delete: `ix-cli/src/mcp/server.ts`
- Delete: `ix-cli/src/mcp/session.ts`
- Delete: `ix-cli/src/mcp/__tests__/server.test.ts`
- Delete: `ix-cli/src/mcp/__tests__/session.test.ts`
- Delete: `ix-cli/src/cli/commands/mcp-install.ts`
- Modify: `ix-cli/src/cli/main.ts`
- Modify: `ix-cli/package.json`

**Step 1: Delete MCP files**

```bash
rm -rf ix-cli/src/mcp/
rm ix-cli/src/cli/commands/mcp-install.ts
```

**Step 2: Remove MCP from main.ts**

In `ix-cli/src/cli/main.ts`:
- Remove the import: `import { registerMcpInstallCommand } from "./commands/mcp-install.js";`
- Remove the registration: `registerMcpInstallCommand(program);`
- Remove the inline `mcp-start` command block (lines 67-72):
```typescript
// DELETE THIS ENTIRE BLOCK:
program
  .command("mcp-start")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    await import("../mcp/server.js");
  });
```

**Step 3: Remove MCP SDK from package.json**

In `ix-cli/package.json`, remove from dependencies:
```json
"@modelcontextprotocol/sdk": "^1.0.0",
```

**Step 4: Remove MCP references from init.ts CLAUDE.md template**

In `ix-cli/src/cli/commands/init.ts`, update the `IX_CLAUDE_MD_BLOCK` template:
- Line 20: change `Use the \`ix\` CLI exclusively. Do NOT use MCP tools — the CLI is the canonical agent interface.` to `Use the \`ix\` CLI exclusively. All commands support \`--format json\`.`
- Line 66: remove `- MCP tools — deprecated, use CLI instead`

**Step 5: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

Expected: Build succeeds, all existing tests pass (MCP tests are deleted so they won't run).

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: remove MCP completely — CLI is the only agent interface"
```

---

### Task 2: CLI output fix — stderr for diagnostics

**Files:**
- Create: `ix-cli/src/cli/stderr.ts`
- Modify: `ix-cli/src/cli/resolve.ts`

**Step 1: Create stderr utility**

Create `ix-cli/src/cli/stderr.ts`:

```typescript
import chalk from "chalk";

/** Write a diagnostic/status message to stderr (never pollutes stdout/JSON). */
export function stderr(message: string): void {
  process.stderr.write(message + "\n");
}

/** Write a styled diagnostic to stderr. */
export function stderrDim(message: string): void {
  process.stderr.write(chalk.dim(message) + "\n");
}
```

**Step 2: Update resolve.ts to use stderr**

In `ix-cli/src/cli/resolve.ts`:

Replace all `console.log` calls with `stderr` imports:

```typescript
import { stderr } from "./stderr.js";
```

Change line 27:
```typescript
// OLD: console.log(`No entity found matching "${symbol}".`);
stderr(`No entity found matching "${symbol}".`);
```

Change line 60:
```typescript
// OLD: console.log(`Multiple matches for "${symbol}":`);
stderr(`Multiple matches for "${symbol}":`);
```

Change line 69:
```typescript
// OLD: console.log(`  ${chalk.cyan(...)}`);
stderr(`  ${chalk.cyan((node.kind ?? "").padEnd(10))} ${chalk.dim(shortId)}  ${name}`);
```

Change line 71:
```typescript
// OLD: console.log(chalk.dim(`\nUse --kind <kind> to disambiguate.`));
stderr(chalk.dim(`\nUse --kind <kind> to disambiguate.`));
```

Change line 84 (`printResolved`):
```typescript
// OLD: console.log(`${chalk.dim("Resolved:")} ...`);
stderr(`${chalk.dim("Resolved:")} ${chalk.cyan(target.kind)} ${chalk.dim(shortId)} ${chalk.bold(target.name)}${modeStr}\n`);
```

**Step 3: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 4: Commit**

```bash
git add ix-cli/src/cli/stderr.ts ix-cli/src/cli/resolve.ts
git commit -m "feat: route diagnostic output to stderr — stdout reserved for data"
```

---

### Task 3: Add Plan and Task node kinds to backend

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/model/Node.scala`

**Step 1: Add Plan and Task to NodeKind**

In `memory-layer/src/main/scala/ix/memory/model/Node.scala`:

Add after `case object Method extends NodeKind` (line 25):
```scala
  case object Plan        extends NodeKind
  case object Task        extends NodeKind
```

Add to `nameMap` after `"method" -> Method`:
```scala
    "plan"         -> Plan,
    "task"         -> Task
```

Add to `encoder` after `case Method => "method"`:
```scala
    case Plan        => "plan"
    case Task        => "task"
```

**Step 2: Verify backend compiles**

```bash
cd memory-layer && sbt compile
```

Expected: Compiles cleanly. The exhaustive match in the encoder will require all cases.

**Step 3: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/model/Node.scala
git commit -m "feat: add Plan and Task node kinds to backend"
```

---

### Task 4: Decision linking — extend ix decide

**Files:**
- Modify: `ix-cli/src/cli/commands/decide.ts`
- Test: `ix-cli/src/cli/__tests__/decide-linking.test.ts`

**Step 1: Write the failing test**

Create `ix-cli/src/cli/__tests__/decide-linking.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildDecisionPatch } from "../commands/decide.js";

describe("buildDecisionPatch", () => {
  it("creates a patch with DECISION_AFFECTS edges", () => {
    const patch = buildDecisionPatch(
      "Use client-side patch",
      "Avoid server coupling",
      {
        affects: [
          { id: "entity-1", kind: "class", name: "IngestionService" },
          { id: "entity-2", kind: "class", name: "IxClient" },
        ],
      }
    );
    expect(patch.ops.length).toBe(3); // 1 UpsertNode + 2 UpsertEdge
    expect(patch.ops[0].type).toBe("UpsertNode");
    expect(patch.ops[0].kind).toBe("decision");
    expect(patch.ops[1].type).toBe("UpsertEdge");
    expect(patch.ops[1].predicate).toBe("DECISION_AFFECTS");
    expect(patch.ops[2].predicate).toBe("DECISION_AFFECTS");
  });

  it("creates DECISION_SUPERSEDES edge when supersedes is provided", () => {
    const patch = buildDecisionPatch("New approach", "Better", {
      supersedes: "old-decision-id",
    });
    expect(patch.ops.length).toBe(2); // 1 UpsertNode + 1 UpsertEdge
    expect(patch.ops[1].predicate).toBe("DECISION_SUPERSEDES");
    expect(patch.ops[1].src).toBe(patch.ops[0].id); // new decision → old
    expect(patch.ops[1].dst).toBe("old-decision-id");
  });

  it("creates DECISION_CHILD edge when parent is provided", () => {
    const patch = buildDecisionPatch("Sub-decision", "Detail", {
      parent: "parent-decision-id",
    });
    expect(patch.ops.length).toBe(2);
    expect(patch.ops[1].predicate).toBe("DECISION_CHILD");
    expect(patch.ops[1].src).toBe("parent-decision-id"); // parent → child
    expect(patch.ops[1].dst).toBe(patch.ops[0].id);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd ix-cli && npx vitest run src/cli/__tests__/decide-linking.test.ts
```

Expected: FAIL — `buildDecisionPatch` is not exported.

**Step 3: Implement buildDecisionPatch and update decide command**

Rewrite `ix-cli/src/cli/commands/decide.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveEntity } from "../resolve.js";
import { deterministicId } from "../github/transform.js";
import type { GraphPatchPayload, PatchOp } from "../../client/types.js";

interface DecisionLinkOpts {
  affects?: { id: string; kind: string; name: string }[];
  supersedes?: string;
  parent?: string;
}

export function buildDecisionPatch(
  title: string,
  rationale: string,
  linkOpts: DecisionLinkOpts = {}
): GraphPatchPayload {
  const now = new Date().toISOString();
  const decisionId = deterministicId(`decision:${title}:${now}`);
  const ops: PatchOp[] = [];

  // 1. UpsertNode for the decision
  ops.push({
    type: "UpsertNode",
    id: decisionId,
    kind: "decision",
    name: title,
    attrs: { rationale, created_at: now },
  });

  // 2. DECISION_AFFECTS edges
  if (linkOpts.affects) {
    for (const entity of linkOpts.affects) {
      ops.push({
        type: "UpsertEdge",
        id: deterministicId(`${decisionId}:DECISION_AFFECTS:${entity.id}`),
        src: decisionId,
        dst: entity.id,
        predicate: "DECISION_AFFECTS",
        attrs: {},
      });
    }
  }

  // 3. DECISION_SUPERSEDES edge
  if (linkOpts.supersedes) {
    ops.push({
      type: "UpsertEdge",
      id: deterministicId(`${decisionId}:DECISION_SUPERSEDES:${linkOpts.supersedes}`),
      src: decisionId,
      dst: linkOpts.supersedes,
      predicate: "DECISION_SUPERSEDES",
      attrs: {},
    });
  }

  // 4. DECISION_CHILD edge (parent → child)
  if (linkOpts.parent) {
    ops.push({
      type: "UpsertEdge",
      id: deterministicId(`${linkOpts.parent}:DECISION_CHILD:${decisionId}`),
      src: linkOpts.parent,
      dst: decisionId,
      predicate: "DECISION_CHILD",
      attrs: {},
    });
  }

  return {
    patchId: decisionId,
    actor: "ix-cli",
    timestamp: now,
    source: {
      uri: `ix://decision/${encodeURIComponent(title)}`,
      extractor: "ix-cli:decide",
      sourceType: "Decision",
    },
    baseRev: 0,
    ops,
    replaces: [],
  };
}

export function registerDecideCommand(program: Command): void {
  program
    .command("decide <title>")
    .description("Record a design decision")
    .requiredOption("--rationale <text>", "Rationale for the decision")
    .option("--intent-id <id>", "Link to an intent")
    .option("--affects <entities>", "Comma-separated entity names to link (creates DECISION_AFFECTS edges)")
    .option("--supersedes <id>", "Decision ID this supersedes")
    .option("--parent <id>", "Parent decision ID")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(
      async (
        title: string,
        opts: {
          rationale: string;
          intentId?: string;
          affects?: string;
          supersedes?: string;
          parent?: string;
          format: string;
        }
      ) => {
        const client = new IxClient(getEndpoint());
        const hasLinks = opts.affects || opts.supersedes || opts.parent;

        if (hasLinks) {
          // Use GraphPatch path for linked decisions
          let resolvedAffects: { id: string; kind: string; name: string }[] | undefined;

          if (opts.affects) {
            const names = opts.affects.split(",").map((s) => s.trim());
            resolvedAffects = [];
            for (const name of names) {
              const resolved = await resolveEntity(client, name, [
                "class", "module", "file", "function", "method", "trait", "object", "interface",
              ]);
              if (resolved) {
                resolvedAffects.push({ id: resolved.id, kind: resolved.kind, name: resolved.name });
              }
            }
          }

          const patch = buildDecisionPatch(title, opts.rationale, {
            affects: resolvedAffects,
            supersedes: opts.supersedes,
            parent: opts.parent,
          });

          if (opts.intentId) {
            patch.intent = opts.intentId;
          }

          const result = await client.commitPatch(patch);
          if (opts.format === "json") {
            console.log(JSON.stringify({ ...result, decisionId: patch.ops[0].id }, null, 2));
          } else {
            console.log(`Decision recorded: ${patch.ops[0].id} (rev ${result.rev})`);
            if (resolvedAffects?.length) {
              console.log(`  Linked to: ${resolvedAffects.map((e) => e.name).join(", ")}`);
            }
          }
        } else {
          // Use the original backend endpoint for simple decisions
          const result = await client.decide(title, opts.rationale, { intentId: opts.intentId });
          if (opts.format === "json") {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Decision recorded: ${result.nodeId} (rev ${result.rev})`);
          }
        }
      }
    );
}
```

**Step 4: Run tests**

```bash
cd ix-cli && npx vitest run src/cli/__tests__/decide-linking.test.ts
```

Expected: PASS (3 tests)

**Step 5: Verify full build and all tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 6: Commit**

```bash
git add ix-cli/src/cli/commands/decide.ts ix-cli/src/cli/__tests__/decide-linking.test.ts
git commit -m "feat: add decision linking — --affects, --supersedes, --parent flags"
```

---

### Task 5: Surface decisions in ix overview

**Files:**
- Modify: `ix-cli/src/cli/commands/overview.ts`

**Step 1: Add decisions field to OverviewResult interface**

In `ix-cli/src/cli/commands/overview.ts`, add to `OverviewResult` interface (after `signature: string | null;`):

```typescript
  decisions: { id: string; title: string; rationale?: string }[];
```

**Step 2: Fetch DECISION_AFFECTS edges in overviewContainer**

In the `overviewContainer` function, add to the `Promise.all` array (after the inboundResult fetch):

```typescript
    client.expand(target.id, { direction: "in", predicates: ["DECISION_AFFECTS"] }),
```

Destructure the result:
```typescript
  const [details, membersResult, importsResult, inboundResult, decisionsResult] = await Promise.all([...]);
```

Map the decisions:
```typescript
  const decisions = decisionsResult.nodes.map((n: any) => ({
    id: n.id,
    title: n.name || n.attrs?.name || "(unnamed)",
    rationale: n.attrs?.rationale ?? undefined,
  }));
```

Add to the result object:
```typescript
    decisions,
```

Add to text output (after the key members section):
```typescript
    if (decisions.length > 0) {
      console.log(`\nDecisions:`);
      for (const d of decisions) {
        console.log(`  ${chalk.yellow(d.title)}`);
      }
    }
```

**Step 3: Do the same for overviewCallable**

Add `DECISION_AFFECTS` expand to the callable path's `Promise.all`, map the results, add to output.

**Step 4: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 5: Commit**

```bash
git add ix-cli/src/cli/commands/overview.ts
git commit -m "feat: surface linked decisions in ix overview output"
```

---

### Task 6: Plan graph — goal aliases

**Files:**
- Create: `ix-cli/src/cli/commands/goal.ts`
- Modify: `ix-cli/src/cli/main.ts`

**Step 1: Create goal command (aliases for truth)**

Create `ix-cli/src/cli/commands/goal.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatIntents } from "../format.js";

export function registerGoalCommand(program: Command): void {
  const goal = program
    .command("goal")
    .description("Manage project goals (aliases for ix truth)");

  goal
    .command("create <statement>")
    .description("Create a new goal")
    .option("--parent <id>", "Parent goal ID")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (statement: string, opts: { parent?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.createTruth(statement, opts.parent);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Goal created: ${result.nodeId} (rev ${result.rev})`);
      }
    });

  goal
    .command("list")
    .description("List all goals")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const intents = await client.listTruth();
      formatIntents(intents, opts.format);
    });
}
```

**Step 2: Register in main.ts**

Add import:
```typescript
import { registerGoalCommand } from "./commands/goal.js";
```

Add registration:
```typescript
registerGoalCommand(program);
```

**Step 3: Verify build**

```bash
cd ix-cli && npm run build
```

**Step 4: Commit**

```bash
git add ix-cli/src/cli/commands/goal.ts ix-cli/src/cli/main.ts
git commit -m "feat: add ix goal create/list — aliases for ix truth"
```

---

### Task 7: Plan graph — plan create command

**Files:**
- Create: `ix-cli/src/cli/commands/plan.ts`
- Create: `ix-cli/src/cli/__tests__/plan-patch.test.ts`
- Modify: `ix-cli/src/cli/main.ts`

**Step 1: Write the failing test**

Create `ix-cli/src/cli/__tests__/plan-patch.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildPlanPatch, buildTaskPatch, buildTaskUpdatePatch } from "../commands/plan.js";

describe("buildPlanPatch", () => {
  it("creates a Plan node and GOAL_HAS_PLAN edge", () => {
    const patch = buildPlanPatch("GitHub Ingestion", "goal-id-123");
    expect(patch.ops.length).toBe(2);
    expect(patch.ops[0].type).toBe("UpsertNode");
    expect(patch.ops[0].kind).toBe("plan");
    expect(patch.ops[0].name).toBe("GitHub Ingestion");
    expect(patch.ops[1].type).toBe("UpsertEdge");
    expect(patch.ops[1].predicate).toBe("GOAL_HAS_PLAN");
    expect(patch.ops[1].src).toBe("goal-id-123");
    expect(patch.ops[1].dst).toBe(patch.ops[0].id);
  });
});

describe("buildTaskPatch", () => {
  it("creates a Task node and PLAN_HAS_TASK edge", () => {
    const patch = buildTaskPatch("Fetch GitHub API", { planId: "plan-123" });
    expect(patch.ops[0].type).toBe("UpsertNode");
    expect(patch.ops[0].kind).toBe("task");
    expect(patch.ops[0].attrs.status).toBe("pending");
    expect(patch.ops[1].predicate).toBe("PLAN_HAS_TASK");
  });

  it("adds DEPENDS_ON edge when dependsOn is provided", () => {
    const patch = buildTaskPatch("Transform layer", {
      planId: "plan-123",
      dependsOn: "task-abc",
    });
    expect(patch.ops.length).toBe(3); // node + PLAN_HAS_TASK + DEPENDS_ON
    expect(patch.ops[2].predicate).toBe("DEPENDS_ON");
    expect(patch.ops[2].src).toBe(patch.ops[0].id); // this task depends on...
    expect(patch.ops[2].dst).toBe("task-abc");
  });

  it("adds TASK_AFFECTS edges when affects is provided", () => {
    const patch = buildTaskPatch("Wire up service", {
      planId: "plan-123",
      affects: [
        { id: "entity-1", kind: "class", name: "IngestionService" },
      ],
    });
    expect(patch.ops.length).toBe(3); // node + PLAN_HAS_TASK + TASK_AFFECTS
    expect(patch.ops[2].predicate).toBe("TASK_AFFECTS");
  });
});

describe("buildTaskUpdatePatch", () => {
  it("creates an AssertClaim for status change", () => {
    const patch = buildTaskUpdatePatch("task-id-123", "done");
    expect(patch.ops.length).toBe(1);
    expect(patch.ops[0].type).toBe("AssertClaim");
    expect(patch.ops[0].field).toBe("status");
    expect(patch.ops[0].value).toBe("done");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd ix-cli && npx vitest run src/cli/__tests__/plan-patch.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement plan.ts**

Create `ix-cli/src/cli/commands/plan.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveEntity } from "../resolve.js";
import { deterministicId } from "../github/transform.js";
import type { GraphPatchPayload, PatchOp } from "../../client/types.js";

// ── Patch builders (exported for testing) ────────────────────────────────

export function buildPlanPatch(title: string, goalId: string): GraphPatchPayload {
  const now = new Date().toISOString();
  const planId = deterministicId(`plan:${title}:${now}`);
  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: planId,
      kind: "plan",
      name: title,
      attrs: { created_at: now },
    },
    {
      type: "UpsertEdge",
      id: deterministicId(`${goalId}:GOAL_HAS_PLAN:${planId}`),
      src: goalId,
      dst: planId,
      predicate: "GOAL_HAS_PLAN",
      attrs: {},
    },
  ];

  return {
    patchId: planId,
    actor: "ix-cli",
    timestamp: now,
    source: {
      uri: `ix://plan/${encodeURIComponent(title)}`,
      extractor: "ix-cli:plan",
      sourceType: "Plan",
    },
    baseRev: 0,
    ops,
    replaces: [],
  };
}

interface TaskOpts {
  planId: string;
  dependsOn?: string;
  affects?: { id: string; kind: string; name: string }[];
}

export function buildTaskPatch(title: string, opts: TaskOpts): GraphPatchPayload {
  const now = new Date().toISOString();
  const taskId = deterministicId(`task:${title}:${now}`);
  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: taskId,
      kind: "task",
      name: title,
      attrs: { status: "pending", created_at: now },
    },
    {
      type: "UpsertEdge",
      id: deterministicId(`${opts.planId}:PLAN_HAS_TASK:${taskId}`),
      src: opts.planId,
      dst: taskId,
      predicate: "PLAN_HAS_TASK",
      attrs: {},
    },
  ];

  if (opts.dependsOn) {
    ops.push({
      type: "UpsertEdge",
      id: deterministicId(`${taskId}:DEPENDS_ON:${opts.dependsOn}`),
      src: taskId,
      dst: opts.dependsOn,
      predicate: "DEPENDS_ON",
      attrs: {},
    });
  }

  if (opts.affects) {
    for (const entity of opts.affects) {
      ops.push({
        type: "UpsertEdge",
        id: deterministicId(`${taskId}:TASK_AFFECTS:${entity.id}`),
        src: taskId,
        dst: entity.id,
        predicate: "TASK_AFFECTS",
        attrs: {},
      });
    }
  }

  return {
    patchId: taskId,
    actor: "ix-cli",
    timestamp: now,
    source: {
      uri: `ix://task/${encodeURIComponent(title)}`,
      extractor: "ix-cli:plan",
      sourceType: "Task",
    },
    baseRev: 0,
    ops,
    replaces: [],
  };
}

export function buildTaskUpdatePatch(taskId: string, status: string): GraphPatchPayload {
  const now = new Date().toISOString();
  return {
    patchId: deterministicId(`task-update:${taskId}:${status}:${now}`),
    actor: "ix-cli",
    timestamp: now,
    source: {
      uri: `ix://task-update/${taskId}`,
      extractor: "ix-cli:task",
      sourceType: "Task",
    },
    baseRev: 0,
    ops: [
      {
        type: "AssertClaim",
        entityId: taskId,
        field: "status",
        value: status,
        confidence: 1.0,
      },
    ],
    replaces: [],
  };
}

// ── CLI command registration ─────────────────────────────────────────────

export function registerPlanCommand(program: Command): void {
  const plan = program
    .command("plan")
    .description("Manage plans and tasks");

  plan
    .command("create <title>")
    .description("Create a new plan linked to a goal")
    .requiredOption("--goal <id>", "Goal (intent) ID to link this plan to")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (title: string, opts: { goal: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const patch = buildPlanPatch(title, opts.goal);
      const result = await client.commitPatch(patch);
      const planId = patch.ops[0].id;
      if (opts.format === "json") {
        console.log(JSON.stringify({ ...result, planId }, null, 2));
      } else {
        console.log(`Plan created: ${planId} (rev ${result.rev})`);
      }
    });

  plan
    .command("task <title>")
    .description("Add a task to a plan")
    .requiredOption("--plan <id>", "Plan ID to add this task to")
    .option("--depends-on <id>", "Task ID this depends on")
    .option("--affects <entities>", "Comma-separated entity names this task affects")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(
      async (
        title: string,
        opts: {
          plan: string;
          dependsOn?: string;
          affects?: string;
          format: string;
        }
      ) => {
        const client = new IxClient(getEndpoint());
        let resolvedAffects: { id: string; kind: string; name: string }[] | undefined;

        if (opts.affects) {
          const names = opts.affects.split(",").map((s) => s.trim());
          resolvedAffects = [];
          for (const name of names) {
            const resolved = await resolveEntity(client, name, [
              "class", "module", "file", "function", "method", "trait", "object", "interface",
            ]);
            if (resolved) {
              resolvedAffects.push({ id: resolved.id, kind: resolved.kind, name: resolved.name });
            }
          }
        }

        const patch = buildTaskPatch(title, {
          planId: opts.plan,
          dependsOn: opts.dependsOn,
          affects: resolvedAffects,
        });
        const result = await client.commitPatch(patch);
        const taskId = patch.ops[0].id;
        if (opts.format === "json") {
          console.log(JSON.stringify({ ...result, taskId }, null, 2));
        } else {
          console.log(`Task created: ${taskId} (rev ${result.rev})`);
        }
      }
    );

  plan
    .command("status <planId>")
    .description("Show plan status — tasks, critical path, next actionable")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (planId: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      // 1. Get all tasks in this plan
      const tasksResult = await client.expand(planId, {
        direction: "out",
        predicates: ["PLAN_HAS_TASK"],
      });
      const tasks = tasksResult.nodes;

      // 2. For each task, get status claim and dependencies
      const taskDetails = await Promise.all(
        tasks.map(async (t: any) => {
          const [entityResult, depsResult] = await Promise.all([
            client.entity(t.id),
            client.expand(t.id, { direction: "out", predicates: ["DEPENDS_ON"] }),
          ]);
          const claims = (entityResult.claims ?? []) as any[];
          const statusClaim = claims.find((c: any) => c.field === "status" || c.statement?.includes("status"));
          const status = t.attrs?.status ?? statusClaim?.value ?? "pending";
          const deps = depsResult.nodes.map((d: any) => d.id);
          return {
            id: t.id,
            title: t.name || t.attrs?.name || "(unnamed)",
            status: String(status),
            dependsOn: deps,
          };
        })
      );

      // 3. Find next actionable: not done, all deps satisfied
      const doneIds = new Set(
        taskDetails.filter((t) => t.status === "done").map((t) => t.id)
      );
      const actionable = taskDetails.filter(
        (t) => t.status !== "done" && t.status !== "abandoned" && t.dependsOn.every((d) => doneIds.has(d))
      );
      const nextActionable = actionable.length > 0 ? actionable[0].title : null;

      // 4. Critical path: tasks with most downstream dependents
      const dependentCount = new Map<string, number>();
      for (const t of taskDetails) {
        for (const dep of t.dependsOn) {
          dependentCount.set(dep, (dependentCount.get(dep) || 0) + 1);
        }
      }
      const criticalPath = taskDetails
        .filter((t) => (dependentCount.get(t.id) || 0) > 0)
        .sort((a, b) => (dependentCount.get(b.id) || 0) - (dependentCount.get(a.id) || 0))
        .map((t) => t.title);

      if (opts.format === "json") {
        console.log(
          JSON.stringify(
            {
              planId,
              tasks: taskDetails.map((t) => ({ title: t.title, status: t.status, id: t.id })),
              criticalPath,
              nextActionable,
              summary: {
                total: taskDetails.length,
                done: taskDetails.filter((t) => t.status === "done").length,
                pending: taskDetails.filter((t) => t.status === "pending").length,
                inProgress: taskDetails.filter((t) => t.status === "in_progress").length,
                blocked: taskDetails.filter((t) => t.status === "blocked").length,
              },
            },
            null,
            2
          )
        );
      } else {
        console.log(`Plan: ${planId}\n`);
        for (const t of taskDetails) {
          const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : t.status === "blocked" ? "✗" : "○";
          console.log(`  ${icon} [${t.status.padEnd(11)}] ${t.title}`);
        }
        if (nextActionable) {
          console.log(`\nNext: ${nextActionable}`);
        }
      }
    });

  plan
    .command("next <planId>")
    .description("Show the next actionable task in a plan")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (planId: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      const tasksResult = await client.expand(planId, {
        direction: "out",
        predicates: ["PLAN_HAS_TASK"],
      });
      const tasks = tasksResult.nodes;

      const taskDetails = await Promise.all(
        tasks.map(async (t: any) => {
          const depsResult = await client.expand(t.id, {
            direction: "out",
            predicates: ["DEPENDS_ON"],
          });
          const status = t.attrs?.status ?? "pending";
          return {
            id: t.id,
            title: t.name || t.attrs?.name || "(unnamed)",
            status: String(status),
            dependsOn: depsResult.nodes.map((d: any) => d.id),
          };
        })
      );

      const doneIds = new Set(
        taskDetails.filter((t) => t.status === "done").map((t) => t.id)
      );
      const actionable = taskDetails.filter(
        (t) => t.status !== "done" && t.status !== "abandoned" && t.dependsOn.every((d) => doneIds.has(d))
      );

      if (actionable.length === 0) {
        if (opts.format === "json") {
          console.log(JSON.stringify({ task: null, reason: "no actionable tasks" }, null, 2));
        } else {
          console.log("No actionable tasks remaining.");
        }
        return;
      }

      const next = actionable[0];
      if (opts.format === "json") {
        console.log(
          JSON.stringify(
            { task: next.title, taskId: next.id, reason: "all dependencies satisfied" },
            null,
            2
          )
        );
      } else {
        console.log(`Next: ${next.title}`);
        console.log(`  ID: ${next.id}`);
        console.log(`  Reason: all dependencies satisfied`);
      }
    });
}

// ── Task update command (top-level) ──────────────────────────────────────

export function registerTaskCommand(program: Command): void {
  const task = program
    .command("task")
    .description("Manage tasks");

  task
    .command("update <taskId>")
    .description("Update task status")
    .requiredOption("--status <status>", "New status: pending, in_progress, blocked, done, abandoned")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (taskId: string, opts: { status: string; format: string }) => {
      const validStatuses = ["pending", "in_progress", "blocked", "done", "abandoned"];
      if (!validStatuses.includes(opts.status)) {
        console.error(`Invalid status: ${opts.status}. Valid: ${validStatuses.join(", ")}`);
        process.exit(1);
      }

      const client = new IxClient(getEndpoint());
      const patch = buildTaskUpdatePatch(taskId, opts.status);
      const result = await client.commitPatch(patch);
      if (opts.format === "json") {
        console.log(JSON.stringify({ ...result, taskId, status: opts.status }, null, 2));
      } else {
        console.log(`Task ${taskId} → ${opts.status} (rev ${result.rev})`);
      }
    });
}
```

**Step 4: Register in main.ts**

Add imports:
```typescript
import { registerPlanCommand, registerTaskCommand } from "./commands/plan.js";
```

Add registrations:
```typescript
registerPlanCommand(program);
registerTaskCommand(program);
```

**Step 5: Run tests**

```bash
cd ix-cli && npx vitest run src/cli/__tests__/plan-patch.test.ts
```

Expected: PASS (4 tests)

**Step 6: Verify full build and all tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 7: Commit**

```bash
git add ix-cli/src/cli/commands/plan.ts ix-cli/src/cli/commands/goal.ts ix-cli/src/cli/__tests__/plan-patch.test.ts ix-cli/src/cli/main.ts
git commit -m "feat: add plan graph — ix goal, ix plan, ix task commands"
```

---

### Task 8: Surface tasks in ix overview

**Files:**
- Modify: `ix-cli/src/cli/commands/overview.ts`

**Step 1: Add tasks field to OverviewResult**

Add to `OverviewResult` interface (after `decisions`):
```typescript
  tasks: { id: string; title: string; status: string }[];
```

**Step 2: Fetch TASK_AFFECTS edges in both container and callable paths**

Add to both `Promise.all` arrays:
```typescript
    client.expand(target.id, { direction: "in", predicates: ["TASK_AFFECTS"] }),
```

Map the results:
```typescript
  const tasks = tasksResult.nodes.map((n: any) => ({
    id: n.id,
    title: n.name || n.attrs?.name || "(unnamed)",
    status: n.attrs?.status ?? "pending",
  }));
```

Add to text output:
```typescript
    if (tasks.length > 0) {
      console.log(`\nTasks:`);
      for (const t of tasks) {
        const icon = t.status === "done" ? "✓" : "○";
        console.log(`  ${icon} [${t.status}] ${t.title}`);
      }
    }
```

**Step 3: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 4: Commit**

```bash
git add ix-cli/src/cli/commands/overview.ts
git commit -m "feat: surface linked tasks in ix overview output"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `ix-cli/src/cli/commands/init.ts` (CLAUDE.md template)

**Step 1: Update AGENTS.md**

Remove all MCP references. Add plan/decision commands to routing:

Add to the "Start here" section:
```
ix goal create <statement> --format json      # Create a project goal
ix plan create <title> --goal <id> --format json  # Create a plan
ix plan next <plan-id> --format json          # Next actionable task
ix decide <title> --rationale <text> --affects <entities> --format json  # Record linked decision
```

Add a new "Planning & Decisions" section:
```
### Planning & decisions
ix goal create "GitHub ingestion pipeline" --format json
ix plan create "GitHub Ingestion" --goal <goal-id> --format json
ix plan task "API fetch layer" --plan <plan-id> --depends-on <task-id> --format json
ix plan status <plan-id> --format json
ix plan next <plan-id> --format json
ix task update <task-id> --status done --format json
ix decide "Use client-side patch" --rationale "..." --affects IngestionService --format json
```

Remove MCP references from all sections.

**Step 2: Update CLAUDE.md**

Add to the "High-Level Workflow Commands" table:
```
| Plan work | `ix plan` | `ix plan next <plan-id> --format json` |
| Track decisions | `ix decide` | `ix decide "Use X" --rationale "..." --affects Entity` |
| Create goals | `ix goal` | `ix goal create "Support GitHub" --format json` |
```

Remove all MCP references. Remove the "Do NOT Use" line about MCP tools.

**Step 3: Update README.md**

Add Plan & Task commands to the CLI Commands section:

```markdown
### Planning & Tasks

| Command | Usage | Description |
|---------|-------|-------------|
| `ix goal create` | `ix goal create <statement>` | Create a project goal |
| `ix goal list` | `ix goal list` | List all goals |
| `ix plan create` | `ix plan create <title> --goal <id>` | Create a plan linked to a goal |
| `ix plan task` | `ix plan task <title> --plan <id>` | Add a task to a plan |
| `ix plan status` | `ix plan status <plan-id>` | Show plan progress and next task |
| `ix plan next` | `ix plan next <plan-id>` | Get the next actionable task |
| `ix task update` | `ix task update <id> --status done` | Update task status |
```

Remove all MCP sections from README.

**Step 4: Update init.ts CLAUDE.md template**

Update the `IX_CLAUDE_MD_BLOCK` in `init.ts` to include the plan/decision commands and remove MCP references. Match the updated CLAUDE.md content.

**Step 5: Verify build**

```bash
cd ix-cli && npm run build && npm test
```

**Step 6: Commit**

```bash
git add AGENTS.md CLAUDE.md README.md ix-cli/src/cli/commands/init.ts
git commit -m "docs: update all docs for plan graph, decision linking, remove MCP"
```

---

Plan complete and saved to `docs/plans/2026-03-08-plan-graph-decision-linking-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?