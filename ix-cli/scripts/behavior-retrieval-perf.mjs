// Copyright 2026 Ix Infrastructure Inc.
// IX_E2E=1 node scripts/behavior-retrieval-perf.mjs <built-Step-3-root> [pairs=40]
// Runs against the isolated E2E stack. Rows include the actual serialized stdio result frame.
import assert from "node:assert/strict";
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
const [base, samples = "40"] = process.argv.slice(2);
const rounds = Number(samples);
assert(
  base && Number.isInteger(rounds) && rounds >= 20,
  "supply the built Step 3 root and at least 20 paired samples",
);
const tmp = mkdtempSync(join(tmpdir(), "ix-retrieval-perf-"));
const clients = [];
const logs = [];
const frames = [];
try {
  const fixture = join(tmp, "fixture");
  mkdirSync(fixture);
  writeFileSync(
    join(fixture, "job.ts"),
    'export class Job {\n  start() { if (this.status === "queued") this.status = "running"; }\n  stop() { this.status = "done"; }\n}\nexport function plain() { return 42; }\n',
  );
  const co = checkout(fixture);
  await resetBackend(env);
  ix(env, co, ["map", "."]);
  for (const [i, build] of [resolve(base), root].entries()) {
    const stage = join(tmp, String(i));
    for (const pkg of ["ix-cli", "core-ingestion"]) {
      const dir = join(stage, pkg);
      mkdirSync(dir, { recursive: true });
      for (const file of ["package.json", "dist"])
        cpSync(join(build, pkg, file), join(dir, file), { recursive: true });
      symlinkSync(realpathSync(join(build, pkg, "node_modules")), join(dir, "node_modules"), "dir");
    }
    const log = join(tmp, i + ".jsonl");
    logs.push(log);
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
        IX_HOME: co.ixHome,
        IX_ENDPOINT: env.endpoint,
        IX_FETCH_LOG: log,
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
    clients.push(client);
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
    const label = [tool, args.target ?? args.symbol, args.structured ? "structured" : "text"].join("/");
    if (process.env.IX_RETRIEVAL_CASE && !process.env.IX_RETRIEVAL_CASE.split(",").includes(label)) continue;
    const runs = [[], []];
    for (let r = 0; r < rounds + 6; r++) {
      for (const i of r % 2 ? [1, 0] : [0, 1]) {
        writeFileSync(logs[i], "");
        const start = performance.now();
        const res = await clients[i].callTool({ name: tool, arguments: args });
        const elapsed = performance.now() - start;
        assert(!res.isError, JSON.stringify(res));
        const text = res.content.map((c) => c.text).join("\n");
        const hasWrites = text.includes("writes this.status") || text.includes('"slotId"');
        assert.equal(hasWrites, Boolean(i && eligible), text.slice(0, 1000));
        const reads = readFileSync(logs[i], "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
          .filter((r) => r.ev === "req");
        assert(
          reads.length && reads.every((r) => !/^\/v1\/(?:patch(?:es\/bulk)?|reset)$/.test(r.path)),
        );
        if (r === 6 && i && args.target === "Job" && tool === "ix_context" && !args.structured)
          console.log(
            JSON.stringify({
              demonstration: text.split("\n").find((line) => line.includes("observed_evidence")),
            }),
          );
        if (r >= 6)
          runs[i].push({
            ms: elapsed,
            slowestRead: Math.max(...reads.map(r=>r.ms)),
            requests: reads.length,
            tokens: Math.ceil(text.length / 2.14),
            bytes: frames[i],
            text,
          });
      }
      if (r >= 6 && !eligible) assert.equal(runs[0].at(-1).text, runs[1].at(-1).text);
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
      slowestReadP95: quantile(rs.map(r=>r.slowestRead),.95),
      requestRange: range(rs.map((r) => r.requests)),
      tokens: range(rs.map((r) => r.tokens)),
      bytes: range(rs.map((r) => r.bytes)),
    }));
    const delta = (key) => 100 * (stats[1][key] / stats[0][key] - 1);
    const pass =
      delta("median") <= (eligible ? 10 : 5) &&
      (!eligible || delta("p95") <= 15) &&
      stats[1].requestRange[1] <=
        stats[0].requestRange[1];
    console.log(
      JSON.stringify({
        tool,
        args,
        rounds,
        stats,
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
