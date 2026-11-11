// Copyright 2026 Ix Infrastructure Inc.

// The API reference against the pinned backend: every method + path in
// docs/api/openapi.yaml must be routed. One request each, with `{}` as the
// body and the nil UUID in every `{id}` slot, so most answer 400 or their
// own not-found; only "no such route" (405, or a 404 that looks like the
// answer to an unknown path) fails. See api-probe.ts.
//
// Some documented routes write (reset, patch, savings): the probe runs against
// the throwaway e2e database, which every scenario resets anyway, and waits
// for any async reset it started before the next file runs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type E2eEnv, e2eEnv, headers, resetBackend } from "./harness.js";
import { type Probe, type ProbeAnswer, UNKNOWN_ROUTE, buildProbes, missingRoute, startedOpId } from "./api-probe.js";

const OPENAPI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "api", "openapi.yaml");

let env: E2eEnv;

beforeAll(() => {
  env = e2eEnv();
});

afterAll(async () => {
  await resetBackend(env);
});

async function send(method: string, url: string, body?: string): Promise<ProbeAnswer> {
  const res = await fetch(`${env.endpoint}${url}`, {
    method: method.toUpperCase(),
    headers: headers(env),
    redirect: "manual",
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

/** An async reset the probe started: wait for it, so it cannot race the next file's reset. */
async function settle(answer: ProbeAnswer): Promise<void> {
  const opId = startedOpId(answer);
  if (opId === null) return;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = await send("get", `/v1/reset/status/${encodeURIComponent(opId)}`);
    if (status.status !== 200) return;
    if (!/"state"\s*:\s*"running"/.test(status.body)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`async reset ${opId} still running after 120 s`);
}

describe("docs/api/openapi.yaml against the pinned backend", () => {
  it("routes every documented method and path", async () => {
    const probes: Probe[] = buildProbes(parse(readFileSync(OPENAPI, "utf8")));
    expect(probes.length).toBeGreaterThan(0);

    // What "no such route" looks like here, per method.
    const unknown = new Map<string, ProbeAnswer>();
    for (const method of new Set(probes.map((p) => p.method))) {
      const answer = await send(method, UNKNOWN_ROUTE, method === "post" || method === "put" || method === "patch" ? "{}" : undefined);
      // Anything else means the baseline did not reach routing (auth, proxy)
      // and every 404 below would be unreadable.
      expect([404, 405], `${method.toUpperCase()} ${UNKNOWN_ROUTE}: ${answer.status} ${answer.body}`).toContain(answer.status);
      unknown.set(method, answer);
    }

    const missing: string[] = [];
    for (const probe of probes) {
      const answer = await send(probe.method, probe.url, probe.body);
      await settle(answer);
      const why = missingRoute(probe, answer, unknown.get(probe.method)!);
      if (why) missing.push(why);
    }
    expect(missing, `documented but not served by the pinned backend:\n${missing.join("\n")}`).toEqual([]);
  });
});
