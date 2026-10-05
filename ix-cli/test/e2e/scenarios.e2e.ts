// Copyright 2026 Ix Infrastructure Inc.

// Real-backend correctness scenarios: after any sequence of edits and maps the
// graph must equal a fresh ingest of the same tree. Run with
// `IX_E2E=1 npm run test:e2e` against the stack from `npm run e2e:up`
// (test/e2e/README.md).
//
// A scenario whose fix has not landed is wrapped in failsUntil([...]) and
// titled "[fails until <task ids>]" with every plan task it waits for. It
// passes while the graphs differ and turns red as soon as they match, so the
// PR that lands the last of those fixes has to unwrap it. A fix that lands
// earlier takes its own id out of the title and the list. Any other error (a
// crashed map, an unreachable database) fails the run either way.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  type Checkout,
  type E2eEnv,
  checkout,
  cleanupScratch,
  e2eEnv,
  freshSignature,
  git,
  map,
  resetBackend,
  expectSameGraph,
  failsUntil,
  signature,
} from "./harness.js";

let env: E2eEnv;

beforeAll(() => {
  env = e2eEnv();
});

beforeEach(async () => {
  await resetBackend(env);
});

afterAll(() => {
  cleanupScratch();
});

function edit(co: Checkout, rel: string, change: (text: string) => string): void {
  const path = join(co.dir, rel);
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (after === before) throw new Error(`edit of ${rel} changed nothing`);
  writeFileSync(path, after);
}

const replaceAll = (from: string, to: string) => (text: string) => text.split(from).join(to);

describe("revert to earlier content", () => {
  it(
    "[fails until BEW-03] A -> B -> A equals A",
    failsUntil(["BEW-03"], async () => {
      const co = checkout("polyglot");
      map(env, co);
      const a = await signature(env, co);

      edit(
        co,
        "app/pricing.py",
        (t) => t + "\n\ndef surcharge(amount):\n    return add_tax(amount) + 100\n",
      );
      map(env, co);
      edit(co, "app/pricing.py", (t) => t.slice(0, t.indexOf("\n\ndef surcharge")));
      map(env, co);

      expectSameGraph("A->B->A", await signature(env, co), a);
    }),
  );

  it(
    "[fails until BEW-03] rename a function and back equals the original",
    failsUntil(["BEW-03"], async () => {
      const co = checkout("polyglot");
      map(env, co);
      const a = await signature(env, co);

      for (const f of ["app/utils.py", "app/repository.py"])
        edit(co, f, replaceAll("to_snake_case", "to_snake_case_renamed"));
      map(env, co);
      git(co.dir, "checkout", "--", ".");
      map(env, co);

      expectSameGraph("rename and back", await signature(env, co), a);
    }),
  );

  it(
    "[fails until BEW-03, IN-04] delete a file and restore it equals the original",
    failsUntil(["BEW-03", "IN-04"], async () => {
      const co = checkout("polyglot");
      map(env, co);
      const a = await signature(env, co);

      rmSync(join(co.dir, "app/pricing.py"));
      map(env, co);
      git(co.dir, "checkout", "--", "app/pricing.py");
      map(env, co);

      expectSameGraph("delete and restore", await signature(env, co), a);
    }),
  );

  it(
    "[fails until BEW-03, IN-04, IN-10] branch round trip equals the starting branch",
    failsUntil(["BEW-03", "IN-04", "IN-10"], async () => {
      const co = checkout("polyglot");
      git(co.dir, "checkout", "-q", "-b", "feature");
      edit(co, "app/services.py", replaceAll("def charge(", "def charge_order("));
      edit(co, "app/services.py", replaceAll("service.charge(", "service.charge_order("));
      edit(co, "web/src/cart.ts", replaceAll("summary()", "describe()"));
      edit(co, "web/src/index.ts", replaceAll("cart.summary()", "cart.describe()"));
      rmSync(join(co.dir, "app/events.py"));
      writeFileSync(
        join(co.dir, "app/audit.py"),
        "from app.utils import slugify\n\n\ndef audit_key(name):\n    return slugify(name)\n",
      );
      git(co.dir, "add", "-A");
      git(co.dir, "commit", "-q", "-m", "feature");
      git(co.dir, "checkout", "-q", "main");

      map(env, co);
      const main = await signature(env, co);
      git(co.dir, "checkout", "-q", "feature");
      map(env, co);
      git(co.dir, "checkout", "-q", "main");
      map(env, co);

      expectSameGraph("branch round trip", await signature(env, co), main);
    }),
  );
});

describe("two workspaces in one backend", () => {
  it("mapping a second workspace leaves the first one's graph alone (BEW-01, backend 1.0.31)", async () => {
    const one = checkout("polyglot");
    const two = checkout("polyglot-b");
    // Both register in one IX_HOME, as two repos on one machine would.
    const shared: Checkout = { dir: two.dir, ixHome: one.ixHome };

    map(env, one);
    const before = await signature(env, one);
    map(env, shared);
    await signature(env, shared); // the second workspace really was ingested

    expectSameGraph("first workspace after the second maps", await signature(env, one), before);
  });
});

describe("incremental equals fresh", () => {
  it(
    "[fails until IN-10] edit one Python file",
    failsUntil(["IN-10"], async () => {
      const co = checkout("polyglot");
      map(env, co);
      edit(co, "app/services.py", (t) => t + "\n# edited\n");
      map(env, co);
      const incremental = await signature(env, co);

      expectSameGraph("python edit", incremental, await freshSignature(env, co));
    }),
  );

  it("edit one TypeScript file", async () => {
    const co = checkout("polyglot");
    map(env, co);
    edit(co, "web/src/cart.ts", (t) => t + "\n// edited\n");
    map(env, co);
    const incremental = await signature(env, co);

    expectSameGraph("typescript edit", incremental, await freshSignature(env, co));
  });

  it(
    "[fails until IN-04, IN-10] rename a file",
    failsUntil(["IN-04", "IN-10"], async () => {
      const co = checkout("polyglot");
      map(env, co);
      renameSync(join(co.dir, "app/events.py"), join(co.dir, "app/bus.py"));
      for (const f of ["app/services.py", "app/api.py"])
        edit(co, f, replaceAll("from app.events import", "from app.bus import"));
      map(env, co);
      const incremental = await signature(env, co);

      expectSameGraph("file rename", incremental, await freshSignature(env, co));
    }),
  );

  it("add a file", async () => {
    const co = checkout("polyglot");
    map(env, co);
    writeFileSync(
      join(co.dir, "app/refunds.py"),
      "from app.pricing import add_tax\nfrom app.utils import format_money\n\n\ndef refund(amount):\n    return format_money(-add_tax(amount))\n",
    );
    map(env, co);
    const incremental = await signature(env, co);

    expectSameGraph("file add", incremental, await freshSignature(env, co));
  });

  it("map twice gives the same graph", async () => {
    const co = checkout("polyglot");
    map(env, co);
    const first = await signature(env, co);
    map(env, co);

    expectSameGraph("map twice", await signature(env, co), first);
  });
});
