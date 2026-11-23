// Copyright 2026 Ix Infrastructure Inc.
// IX_E2E=1 node scripts/behavior-retrieval-perf.mjs <built-Step-3-root> [pairs-per-session=40] [sessions=1]
// Runs against the isolated E2E stack. Rows include the actual serialized stdio result frame.
import assert from "node:assert/strict";
import { pairedGate } from "./behavior-perf-interval.mjs";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkout, cleanupScratch, e2eEnv, ix, resetBackend } from "../test/e2e/harness.ts";

const env = e2eEnv();
const root = fileURLToPath(new URL("../../", import.meta.url));
const [base, samples = "40", sessionCount = "1"] = process.argv.slice(2);
const rounds = Number(samples);
const sessions = Number(sessionCount);
assert(Number.isInteger(sessions) && sessions >= 1);
const control = process.env.IX_RETRIEVAL_CONTROL === "1";
assert(
  base && Number.isInteger(rounds) && rounds >= 20,
  "supply the built Step 3 root and at least 20 paired samples",
);
// The boolean comparison needs each reader's own writer provenance. Use two
// disposable databases with the same checkout (and hence the same symbol IDs).
const flowPilot = process.env.IX_FLOW_PILOT === "1";
const pilot = flowPilot || process.env.IX_BOOLEAN_PILOT === "1";
const databases = [env, env];
if (pilot) {
  const peer = e2eEnv({...process.env, IX_E2E_ENDPOINT: process.env.IX_PILOT_BASE_ENDPOINT,
    IX_E2E_ARANGO_URL: process.env.IX_PILOT_BASE_ARANGO_URL});
  assert(process.env.IX_PILOT_BASE_ENDPOINT && process.env.IX_PILOT_BASE_ARANGO_URL);
  assert(peer.endpoint !== env.endpoint && peer.arangoUrl !== env.arangoUrl);
  databases[0] = peer;
}
const tmp = mkdtempSync(join(tmpdir(), "ix-retrieval-perf-"));
const clients = [];
const logs = [];
const frames = [];
try {
  const fixture = join(tmp, "fixture");
  mkdirSync(fixture);
  writeFileSync(
    join(fixture, "job.ts"),
    flowPilot ? 'export class Job {\n stopped=false;\n work(){if(this.stopped)return; tick();}\n start(){try{while(again)this.stopped=true;}finally{this.stopped=false;}}\n}\nexport function plain(){return 42;}\n' :
    pilot ? 'export class Job {\n stopped=false;\n work(){if(this.stopped)return; tick();}\n start(){this.stopped=true;}\n}\nexport function plain(){return 42;}\n' :
    'export class Job {\n  start() { if (this.status === "queued") this.status = "running"; }\n  stop() { this.status = "done"; }\n}\nexport function plain() { return 42; }\n',
  );
  const co = checkout(fixture);
  const homes = [co.ixHome, co.ixHome];
  if (!pilot) {
    await resetBackend(env);
    ix(env, co, ["map", "."]);
  }
  for (const [i, build] of [resolve(base), control ? resolve(base) : root].entries()) {
    const stage = join(tmp, String(i));
    for (const pkg of ["ix-cli", "core-ingestion"]) {
      const dir = join(stage, pkg);
      mkdirSync(dir, { recursive: true });
      for (const file of ["package.json", "dist"])
        cpSync(join(build, pkg, file), join(dir, file), { recursive: true });
      symlinkSync(realpathSync(join(build, pkg, "node_modules")), join(dir, "node_modules"), "dir");
    }
    if (pilot) {
      homes[i] = join(tmp, "home-" + i);
      mkdirSync(homes[i]);
      await resetBackend(databases[i]);
      execFileSync(process.execPath, [join(stage, "ix-cli/dist/cli/main.js"), "map", "."], {
        cwd: co.dir, env: {...process.env, IX_HOME: homes[i], IX_ENDPOINT: databases[i].endpoint, IX_NO_UPDATE_CHECK: "1"}
      });
    }
    logs[i] = join(tmp, i + ".jsonl");
  }
  async function startClient(i) {
    const stage = join(tmp, String(i));
    const trans = new StdioClientTransport({
      command: process.execPath,
      cwd: co.dir,
      args: [
        "--import",
        join(root, "ix-cli/scripts/fetch-log.mjs"),
        join(stage, "ix-cli/dist/cli/main.js"),
        "mcp",
        "--tools",
        "all",
      ],
      env: {
        ...process.env,
        IX_HOME: homes[i],
        IX_ENDPOINT: databases[i].endpoint,
        IX_FETCH_LOG: logs[i],
        IX_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
    });
    const client = new Client({ name: "ix-release-benchmark", version: "1" });
    await client.connect(trans);
    const receive = trans.onmessage;
    trans.onmessage = (message, ...rest) => {
      if ("result" in message) frames[i] = Buffer.byteLength(JSON.stringify(message)) + 1;
      return receive.call(trans, message, ...rest);
    };
    clients[i] = client;
  }
  const quantile = (values, q) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
  const range = (values) => [Math.min(...values), Math.max(...values)];
  for (const [tool, args, eligible] of [
    ["ix_context", { target: "plain" }, false],
    ["ix_context", { target: "Job" }, true],
    ["ix_context", { target: "Job", structured: true }, true],
    ["ix_impact", { target: "plain" }, false],
    ["ix_impact", { target: "Job" }, true],
    ["ix_impact", { target: "start" }, true],
    ["ix_explain", { symbol: "plain" }, false],
    ["ix_explain", { symbol: "Job" }, true],
  ]) {
    const label = [tool, args.target ?? args.symbol, args.structured ? "structured" : "text"].join(
      "/",
    );
    if (process.env.IX_RETRIEVAL_CASE && !process.env.IX_RETRIEVAL_CASE.split(",").includes(label))
      continue;
    const runs = [[], []];
    for (let session = 0; session < sessions; session++) {
      if (sessions > 1 || !clients.length) {
        await Promise.all(clients.splice(0).map((client) => client.close()));
        for (const i of session % 2 ? [1, 0] : [0, 1]) await startClient(i);
      }
      for (let r = 0; r < rounds + 6; r++) {
        for (const i of (r + session) % 2 ? [1, 0] : [0, 1]) {
          writeFileSync(logs[i], "");
          const start = performance.now();
          const res = await clients[i].callTool({ name: tool, arguments: args });
          const elapsed = performance.now() - start;
          assert(!res.isError, JSON.stringify(res));
          const text = res.content.map((c) => c.text).join("\n");
          const hasWrites = text.includes(pilot ? "writes this.stopped" : "writes this.status") || text.includes('"slotId"');
          assert.equal(hasWrites, Boolean(!control && i && eligible), text.slice(0, 1000));
          const reads = readFileSync(logs[i], "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(JSON.parse)
            .filter((r) => r.ev === "req");
          assert(
            reads.length &&
              reads.every((r) => !/^\/v1\/(?:patch(?:es\/bulk)?|reset)$/.test(r.path)),
          );
          if (r === 6 && i && args.target === "Job" && tool === "ix_context" && !args.structured)
            console.log(
              JSON.stringify({
                demonstration: text.split("\n").find((line) => line.includes("observed_evidence")),
              }),
            );
          let end = 0,
            waiting = 0;
          for (const req of reads.toSorted((a, b) => a.start - b.start)) {
            const next = req.start + req.ms;
            waiting += Math.max(0, next - Math.max(req.start, end));
            end = Math.max(end, next);
          }
          if (r >= 6)
            runs[i].push({
              session,
              backend: waiting,
              outsideBackend: Math.max(0, elapsed - waiting),
              ms: elapsed,
              slowestRead: Math.max(...reads.map((r) => r.ms)),
              requests: reads.length,
              routes: reads.map((r) => r.method + " " + r.path).sort(),
              tokens: Math.ceil(text.length / 2.14),
              bytes: frames[i],
              text,
            });
        }
        if (r >= 6) assert.deepEqual(runs[1].at(-1).routes, runs[0].at(-1).routes, label);
        if (r >= 6 && (!eligible || control))
          assert.equal(runs[0].at(-1).text, runs[1].at(-1).text);
      }
    }
    const stats = runs.map((rs) => ({
      median: quantile(
        rs.map((r) => r.ms),
        0.5,
      ),
      p95: quantile(
        rs.map((r) => r.ms),
        0.95,
      ),
      msRange: range(rs.map((r) => r.ms)),
      backendMedian: quantile(
        rs.map((r) => r.backend),
        0.5,
      ),
      outsideMedian: quantile(
        rs.map((r) => r.outsideBackend),
        0.5,
      ),
      slowestReadP95: quantile(
        rs.map((r) => r.slowestRead),
        0.95,
      ),
      sessionMedians: Array.from({ length: sessions }, (_, i) =>
        quantile(
          rs.filter((r) => r.session === i).map((r) => r.ms),
          0.5,
        ),
      ),
      requestRange: range(rs.map((r) => r.requests)),
      tokens: range(rs.map((r) => r.tokens)),
      bytes: range(rs.map((r) => r.bytes)),
    }));
    const delta = (key) => 100 * (stats[1][key] / stats[0][key] - 1);
    const samplesMs = runs.map(rs => rs.map(row => row.ms));
    const gates = pilot ? [pairedGate(samplesMs, 0.5, eligible ? 10 : 5, sessions, false)] : [];
    if (pilot && eligible) gates.push(pairedGate(samplesMs, 0.95, 15, sessions, false));
    const pass =
      gates.every(gate => gate.decision === "pass") &&
      delta("median") <= (eligible ? 10 : 5) &&
      (!eligible || delta("p95") <= 15) &&
      stats[1].requestRange[1] <= stats[0].requestRange[1];
    console.log(
      JSON.stringify({
        tool,
        args,
        rounds,
        sessions,
        control,
        stats,
        ...(pilot && { samples: samplesMs, gates }),
        medianChange: delta("median"),
        p95Change: delta("p95"),
        pass,
      }),
    );
    if (!pass) process.exitCode = 1;
  }
} finally {
  await Promise.all(clients.map((client) => client.close()));
  cleanupScratch();
  rmSync(tmp, { recursive: true, force: true });
}
